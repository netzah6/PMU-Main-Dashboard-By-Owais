"use client";
import { Fragment, useCallback, useEffect, useState } from "react";
import { useUser } from "@/lib/hooks/useUser";
import { Loader2, RefreshCw, Plus, ExternalLink, Stethoscope, Check, X, Save } from "lucide-react";
import { cn } from "@/lib/utils";

// Funnels — the one-box funnels hosted on Vercel: which client has one,
// its live URL, health, leads and bookings. Content itself is edited in
// each sub-account's GHL custom values; this tab manages existence,
// status and the per-client extras (Fanbasis block, widget, pixel).

type LeadRow = {
  id: number; name: string; phone: string; at: string;
  stage: "lead_only" | "picked_no_deposit" | "paid_no_slot" | "paid_booked" | "paid_followup";
  slot: string | null; variant: string | null;
};

const STAGE_META: Record<LeadRow["stage"], { label: string; cls: string }> = {
  lead_only: { label: "Lead — stopped at booking", cls: "bg-[#f1f5f9] text-[#475569] border-[#e2e8f0]" },
  picked_no_deposit: { label: "Picked a time — no deposit", cls: "bg-[#fff3e6] text-[#c2410c] border-[#fdba74]" },
  paid_no_slot: { label: "PAID — booking failed, call them", cls: "bg-[#fee2e2] text-[#b91c1c] border-[#fca5a5]" },
  paid_booked: { label: "Paid & booked", cls: "bg-[#e7f6ec] text-[#15803d] border-[#bfe3cd]" },
  paid_followup: { label: "Paid via AI follow-up", cls: "bg-[#ede9fe] text-[#6d28d9] border-[#c4b5fd]" },
};

type AbVariant = {
  vkey: string; label: string; kind: string; target: string | null; weight: number;
  overrides?: string[];
  deposits: number | null; aiDeposits: number | null;
  visitors: number; leads: number | null; picked: number | null;
  leadRate: number | null; pickRate: number | null; spend: number | null; costPerBooking: number | null;
};
type AbResult = {
  experiment: { id: number; name: string; status: string; startedAt: string } | null;
  spendWindow: string | null;
  spendOwner?: string | null;
  variants: AbVariant[];
};

type Funnel = {
  slug: string; locationId: string; clientName: string; status: string;
  cvSyncedAt: string | null; url: string;
  hasCalendar: boolean; hasFanbasis: boolean; hasWidget: boolean; hasPixel: boolean;
  oldFunnelUrl: string;
  cv: Record<string, string>;
  visitors: number;
  leads: number;
  paid: number; booked: number; lastLeadAt: string | null;
  abStatus: string | null;
  template: string;
};
type HealthCheck = { name: string; ok: boolean; note: string };

/* Click-to-copy pill for SOP values — the exact string, one click. */
function CopyChip({ text, label, onCopied }: { text: string; label?: string; onCopied: () => void }) {
  return (
    <button
      type="button"
      title={`Copy: ${text}`}
      onClick={(e) => { e.preventDefault(); void navigator.clipboard.writeText(text).then(onCopied); }}
      className="inline-flex items-center gap-1 align-middle font-mono text-[11px] bg-[#f0f6f6] text-[#0b7285] border border-[#bfe3e3] rounded-md px-1.5 py-0.5 hover:bg-[#e2f1f1] cursor-copy max-w-[300px]">
      <span className="truncate">{label ?? text}</span>
      <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
    </button>
  );
}

// The ad's real URL, derived from the renamed page's URL: same address
// minus the -ab-ghl (or legacy -old) suffix. Shown verbatim in the SOP so
// the redirect gets created on exactly the right path.
function adUrlFromRenamed(u: string): string {
  try {
    const x = new URL(u.trim());
    return x.origin + x.pathname.replace(/(-ab-ghl|-old)\/?$/, "");
  } catch { return ""; }
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function Dot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-[11px] font-medium rounded-full border px-2 py-0.5",
      ok ? "bg-[#e7f6ec] text-[#15803d] border-[#bfe3cd]" : "bg-[#fef2f2] text-[#b91c1c] border-[#fca5a5]")}>
      {ok ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}{label}
    </span>
  );
}

/* Shared results table for the split-test overview boxes — the all-clients
   B2C box and the agency's B2B box render the same columns, so the totals
   stay comparable with each card's own Split panel. */
function SplitOverviewTable({ rows, ab, showTotals, footnote }: {
  rows: Funnel[];
  ab: Record<string, AbResult>;
  showTotals: boolean;
  footnote: string;
}) {
  const tot: Record<string, { vis: number; leads: number; picked: number; dep: number; aiDep: number; spend: number }> = {};
  if (showTotals) {
    for (const f of rows) {
      for (const v of ab[f.slug]?.variants ?? []) {
        const k = v.kind === "external" ? "All Original funnels" : "All One-Box funnels";
        const t = (tot[k] ??= { vis: 0, leads: 0, picked: 0, dep: 0, aiDep: 0, spend: 0 });
        t.vis += v.visitors ?? 0; t.leads += v.leads ?? 0;
        t.picked += v.picked ?? 0; t.dep += v.deposits ?? 0;
        t.aiDep += v.aiDeposits ?? 0; t.spend += v.spend ?? 0;
      }
    }
  }
  return (
    <div className="mt-3">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-[#697a91]">
            <tr className="text-left">
              <th className="py-1 pr-3 font-medium">Client</th>
              <th className="py-1 pr-3 font-medium">Variant</th>
              <th className="py-1 pr-3 font-medium">Visitors</th>
              <th className="py-1 pr-3 font-medium">Leads</th>
              <th className="py-1 pr-3 font-medium">Lead rate</th>
              <th className="py-1 pr-3 font-medium">Picked time</th>
              <th className="py-1 pr-3 font-medium">Deposits</th>
              <th className="py-1 pr-3 font-medium">AI deposits</th>
              <th className="py-1 pr-3 font-medium">Pick rate</th>
              <th className="py-1 pr-3 font-medium">Spend</th>
              <th className="py-1 pr-3 font-medium">Cost / booking</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => {
              const d = ab[f.slug];
              if (!d?.variants) {
                return (
                  <tr key={f.slug} className="border-t border-[#eef2f6]">
                    <td className="py-1.5 pr-3 font-medium text-[#1c2b3a]">{f.clientName || f.slug}</td>
                    <td className="py-1.5 pr-3 text-[#97a5b8]" colSpan={10}>loading…</td>
                  </tr>
                );
              }
              const best = d.variants
                .filter((x) => x.costPerBooking != null)
                .sort((a, b) => (a.costPerBooking! - b.costPerBooking!))[0];
              return d.variants.map((v, i) => (
                <tr key={f.slug + v.vkey} className={i === 0 ? "border-t-2 border-[#e0e7f0]" : "border-t border-[#f4f7fa]"}>
                  <td className="py-1.5 pr-3 font-medium text-[#1c2b3a]">{i === 0 ? (f.clientName || f.slug) : ""}</td>
                  <td className="py-1.5 pr-3">
                    {v.label}
                    {best && best.vkey === v.vkey && d.variants.filter((x) => x.costPerBooking != null).length > 1 && (
                      <span className="ml-1.5 text-[10px] font-semibold text-[#15803d]">best</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3">{v.visitors}</td>
                  <td className="py-1.5 pr-3">{v.leads != null ? v.leads : <span className="text-[10px] text-[#97a5b8]">in GHL</span>}</td>
                  <td className="py-1.5 pr-3">{v.leadRate != null ? `${v.leadRate}%` : "—"}</td>
                  <td className="py-1.5 pr-3">{v.picked ?? "—"}</td>
                  <td className="py-1.5 pr-3">{v.deposits != null ? v.deposits : <span className="text-[10px] text-[#97a5b8]">—</span>}</td>
                  <td className="py-1.5 pr-3 text-[#7c3aed] font-medium">{v.aiDeposits != null ? v.aiDeposits : "—"}</td>
                  <td className="py-1.5 pr-3">{v.pickRate != null ? `${v.pickRate}%` : "—"}</td>
                  <td className="py-1.5 pr-3">{v.spend != null ? `$${v.spend}` : "—"}</td>
                  <td className="py-1.5 pr-3 font-semibold text-[#1c2b3a]">{v.costPerBooking != null ? `$${v.costPerBooking}` : "—"}</td>
                </tr>
              ));
            })}
            {Object.entries(tot).map(([label, t]) => (
              <tr key={label} className="border-t-2 border-[#d8b4fe] bg-[#faf7ff] font-semibold text-[#1c2b3a]">
                <td className="py-1.5 pr-3" colSpan={2}>{label}</td>
                <td className="py-1.5 pr-3">{t.vis}</td>
                <td className="py-1.5 pr-3">{t.leads}</td>
                <td className="py-1.5 pr-3">{t.vis ? `${((t.leads / t.vis) * 100).toFixed(1)}%` : "—"}</td>
                <td className="py-1.5 pr-3">{t.picked}</td>
                <td className="py-1.5 pr-3">{t.dep}</td>
                <td className="py-1.5 pr-3 text-[#7c3aed]">{t.aiDep}</td>
                <td className="py-1.5 pr-3">{t.vis ? `${((t.picked / t.vis) * 100).toFixed(1)}%` : "—"}</td>
                <td className="py-1.5 pr-3">{t.spend ? `$${t.spend.toFixed(2)}` : "—"}</td>
                <td className="py-1.5 pr-3">{t.spend && t.picked ? `$${(t.spend / t.picked).toFixed(2)}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[10px] text-[#697a91]">{footnote}</p>
    </div>
  );
}

export default function FunnelsPage() {
  const { role, loading: userLoading } = useUser();
  const [funnels, setFunnels] = useState<Funnel[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [health, setHealth] = useState<Record<string, HealthCheck[]>>({});
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ clientName: "", slug: "", locationId: "", oldFunnelUrl: "" });
  const [addNote, setAddNote] = useState<string | null>(null);
  const [extrasFor, setExtrasFor] = useState<string | null>(null);
  const [cvFor, setCvFor] = useState<string | null>(null);
  const [leadsFor, setLeadsFor] = useState<string | null>(null);
  const [leadRows, setLeadRows] = useState<Record<string, LeadRow[]>>({});
  const [leadFilter, setLeadFilter] = useState<string>("all");
  const [leadsBusy, setLeadsBusy] = useState(false);
  const [cvForm, setCvForm] = useState<Record<string, string>>({});
  const [extrasForm, setExtrasForm] = useState({ fanbasisHtml: "", elfsightId: "", resultImgs: "", metaPixelId: "", oldFunnelUrl: "", ownerName: "" });
  const [toast, setToast] = useState<string | null>(null);
  const [abFor, setAbFor] = useState<string | null>(null);
  const [abMode, setAbMode] = useState<"original" | "versions">("original");
  const [abB, setAbB] = useState({ label: "Version B", headline: "", sub: "", congrats: "", offer: "", bookingHead: "", depositHead: "" });
  const [ab, setAb] = useState<Record<string, AbResult>>({});
  const [abBusy, setAbBusy] = useState(false);
  const [endTest, setEndTest] = useState<{ slug: string; id: number } | null>(null);
  const [endChoice, setEndChoice] = useState<"onebox" | "original">("onebox");
  const [endVerify, setEndVerify] = useState<{ loading?: boolean; applicable?: boolean;
    redirectGone?: boolean; pageBack?: boolean; adUrl?: string; error?: string } | null>(null);
  const [sop, setSop] = useState({ renamed: false, redirect: false, values: false, workflow: false });
  const [abOrigUrl, setAbOrigUrl] = useState("");
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [b2bOverviewOpen, setB2bOverviewOpen] = useState(false);
  const [startVerify, setStartVerify] = useState<{ loading?: boolean; ok?: boolean; adUrl?: string; namedRight?: boolean;
    checks?: { originalReady: boolean; originalNote: string; redirectLive: boolean; redirectNote: string;
      oneboxReady: boolean; oneboxNote: string };
    error?: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/onebox/admin");
      const j = await r.json();
      setFunnels(j.funnels ?? []);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  async function act(action: string, slug: string, extra: Record<string, string> = {}) {
    setBusy(`${action}:${slug}`);
    try {
      const r = await fetch("/api/onebox/admin", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, slug, ...extra }),
      });
      const j = await r.json();
      if (action === "health") setHealth((h) => ({ ...h, [slug]: j.checks ?? [] }));
      else if (j.error) setToast(`Error: ${j.error}`);
      else if (Array.isArray(j.failed) && j.failed.length) setToast(`Saved, but GHL rejected: ${j.failed.join(", ")}`);
      else setToast(action === "resync" ? "Synced from GHL ✓" : "Saved ✓");
      if (action !== "health") await load();
    } finally { setBusy(null); }
  }

  const loadLeads = useCallback(async (slug: string) => {
    setLeadsBusy(true);
    try {
      const r = await fetch(`/api/onebox/leads?slug=${encodeURIComponent(slug)}`);
      const j = await r.json();
      setLeadRows((x) => ({ ...x, [slug]: j.leads ?? [] }));
    } finally { setLeadsBusy(false); }
  }, []);

  const loadAb = useCallback(async (slug: string) => {
    setAbBusy(true);
    try {
      const r = await fetch(`/api/onebox/ab?slug=${encodeURIComponent(slug)}`);
      const j = (await r.json()) as AbResult;
      setAb((x) => ({ ...x, [slug]: j }));
    } finally { setAbBusy(false); }
  }, []);

  async function abAct(slug: string, payload: Record<string, unknown>) {
    setAbBusy(true);
    try {
      const r = await fetch("/api/onebox/ab", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (j.error) setToast(`Error: ${j.error}`);
      else setToast("Saved ✓");
      await loadAb(slug);
    } finally { setAbBusy(false); }
  }

  // Fresh SOP + verification every time the split panel opens or switches mode.
  useEffect(() => {
    setSop({ renamed: false, redirect: false, values: false, workflow: false });
    setStartVerify(null);
  }, [abFor, abMode]);

  async function verifyStart(slug: string) {
    const el = document.getElementById(`ab-orig-${slug}`) as HTMLInputElement | null;
    const target = (el?.value ?? "").trim();
    if (!target) { setToast("Add the original funnel URL first"); return; }
    setStartVerify({ loading: true });
    try {
      const r = await fetch("/api/onebox/ab", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verifyStart", slug, target }),
      });
      const j = await r.json();
      setStartVerify(j.error ? { error: j.error } : j);
    } catch {
      setStartVerify({ error: "network error — try again" });
    }
  }

  async function verifyRevert(id: number) {
    setEndVerify({ loading: true });
    try {
      const r = await fetch("/api/onebox/ab", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verifyRevert", id }),
      });
      const j = await r.json();
      setEndVerify(j.error ? { error: j.error } : j);
    } catch {
      setEndVerify({ error: "network error — try again" });
    }
  }

  async function addFunnel() {
    setBusy("add");
    setAddNote(null);
    try {
      const r = await fetch("/api/onebox/admin", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add", ...addForm }),
      });
      const j = await r.json();
      if (j.error) { setAddNote(`Error: ${j.error}`); return; }
      setAddNote(`Created ${j.url} — ${[j.pixelNote, j.photoNote, j.cvNote].filter(Boolean).join(" · ")}${j.calendarId ? "" : " · ⚠ no calendar id in custom values"}`);
      setAddForm({ clientName: "", slug: "", locationId: "", oldFunnelUrl: "" });
      await load();
    } finally { setBusy(null); }
  }

  if (userLoading) return <div className="p-8 text-[#697a91]"><Loader2 className="w-5 h-5 animate-spin" /></div>;
  if (role !== "admin") return <div className="p-8 text-[#697a91]">Admins only.</div>;

  return (
    <div className="p-4 md:p-6 max-w-[1200px] mx-auto">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-lg font-semibold text-[#1c2b3a]">🧪 One-Box Funnels</h1>
        <div className="flex gap-2">
          <button onClick={() => void load()} className="flex items-center gap-1.5 text-sm border border-[#e4ebf2] rounded-lg px-3 py-1.5 hover:bg-[#f6f9fc]">
            <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} /> Refresh
          </button>
          <button onClick={() => setShowAdd((s) => !s)} className="flex items-center gap-1.5 text-sm bg-[#0e9c9c] text-white rounded-lg px-3 py-1.5 hover:bg-[#0b8383]">
            <Plus className="w-4 h-4" /> Add client
          </button>
        </div>
      </div>
      <p className="text-xs text-[#697a91] mb-4">
        Funnel content is edited in each sub-account&apos;s GHL <b>custom values</b> (changes go live within ~5 minutes, or hit Sync now).
        This tab manages which funnels exist, their status, health and per-client extras.
      </p>

      {toast && <div className="mb-3 text-sm bg-[#e7f6ec] border border-[#bfe3cd] text-[#15803d] rounded-lg px-3 py-2">{toast}</div>}

      {showAdd && (
        <div className="mb-4 border border-[#e4ebf2] rounded-xl p-4 bg-white">
          <div className="font-medium text-sm mb-3 text-[#1c2b3a]">Add a client funnel</div>
          <div className="grid md:grid-cols-2 gap-3">
            <input placeholder="Client / business name" value={addForm.clientName}
              onChange={(e) => setAddForm((f) => ({ ...f, clientName: e.target.value, slug: f.slug || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") }))}
              className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-sm" />
            <input placeholder="Slug (URL path, e.g. pmu-by-ivan)" value={addForm.slug}
              onChange={(e) => setAddForm((f) => ({ ...f, slug: e.target.value }))}
              className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-sm" />
            <input placeholder="GHL sub-account (location) ID" value={addForm.locationId}
              onChange={(e) => setAddForm((f) => ({ ...f, locationId: e.target.value }))}
              className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-sm" />
            <input placeholder="Current funnel URL (for pixel harvest, optional)" value={addForm.oldFunnelUrl}
              onChange={(e) => setAddForm((f) => ({ ...f, oldFunnelUrl: e.target.value }))}
              className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-sm" />
          </div>
          <div className="mt-3 flex items-center gap-3">
            <button onClick={() => void addFunnel()} disabled={busy === "add"}
              className="flex items-center gap-1.5 text-sm bg-[#0e9c9c] text-white rounded-lg px-4 py-2 hover:bg-[#0b8383] disabled:opacity-50">
              {busy === "add" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create &amp; sync from GHL
            </button>
            {addNote && <span className="text-xs text-[#697a91]">{addNote}</span>}
          </div>
          <p className="text-[11px] text-[#697a91] mt-2">
            Created funnels start <b>paused</b> — add the Fanbasis block in Extras, run a health check, then flip to Live.
          </p>
        </div>
      )}

      {loading ? (
        <div className="p-10 text-center text-[#697a91]"><Loader2 className="w-5 h-5 animate-spin inline" /></div>
      ) : funnels.length === 0 ? (
        <div className="p-10 text-center text-[#697a91] text-sm">No funnels yet — add the first client.</div>
      ) : (
        <div className="space-y-3">
          {funnels.some((f) => f.abStatus === "running" && f.slug !== "demo-v3" && f.template !== "b2b") && (
            <div className="border border-[#d8b4fe] rounded-xl bg-white p-4">
              <button
                onClick={() => {
                  const open = !overviewOpen;
                  setOverviewOpen(open);
                  if (open) funnels.filter((f) => f.abStatus === "running" && f.slug !== "demo-v3" && f.template !== "b2b").forEach((f) => void loadAb(f.slug));
                }}
                className="w-full flex items-center gap-2 text-sm font-medium text-[#1c2b3a]">
                <span className="w-2 h-2 rounded-full bg-[#7c3aed] animate-pulse" />
                Split tests overview — all clients
                <span className="text-xs text-[#697a91]">
                  ({funnels.filter((f) => f.abStatus === "running" && f.slug !== "demo-v3" && f.template !== "b2b").length} running)
                </span>
                <span className="ml-auto text-[#697a91]">{overviewOpen ? "▲" : "▼"}</span>
              </button>
              {overviewOpen && (
                <SplitOverviewTable
                  rows={funnels.filter((f) => f.abStatus === "running" && f.slug !== "demo-v3" && f.template !== "b2b")}
                  ab={ab}
                  showTotals
                  footnote="Same numbers as each card's Split test panel, all clients at once. The totals rows sum every running test per side — deposits count funnel-native payments only; the purple AI-deposits column counts payments the AI collected by text afterwards, attributed to the funnel that produced the lead. B2C clients only — the agency's B2B funnel has its own box below."
                />
              )}
            </div>
          )}
          {funnels.some((f) => f.abStatus === "running" && f.template === "b2b") && (
            <div className="border border-[#9fd8d4] rounded-xl bg-white p-4">
              <button
                onClick={() => {
                  const open = !b2bOverviewOpen;
                  setB2bOverviewOpen(open);
                  if (open) funnels.filter((f) => f.abStatus === "running" && f.template === "b2b").forEach((f) => void loadAb(f.slug));
                }}
                className="w-full flex items-center gap-2 text-sm font-medium text-[#1c2b3a]">
                <span className="w-2 h-2 rounded-full bg-[#0e9c9c] animate-pulse" />
                B2B split test — agency funnel
                <span className="text-xs text-[#697a91]">
                  ({funnels.filter((f) => f.abStatus === "running" && f.template === "b2b").length} running)
                </span>
                <span className="ml-auto text-[#697a91]">{b2bOverviewOpen ? "▲" : "▼"}</span>
              </button>
              {b2bOverviewOpen && (
                <SplitOverviewTable
                  rows={funnels.filter((f) => f.abStatus === "running" && f.template === "b2b")}
                  ab={ab}
                  showTotals={false}
                  footnote="The agency's own B2B funnel (PMU Bookings On Demand) — the win here is a booked strategy call, so read Visitors → Leads → Picked time and ignore the deposit columns. Kept out of the client totals above because it's a different business."
                />
              )}
            </div>
          )}
          {[...funnels]
            .sort((a, b) => Number(b.status === "live") - Number(a.status === "live"))
            .map((f, i, arr) => (
            <Fragment key={f.slug}>
            {i > 0 && arr[i - 1].status === "live" && f.status !== "live" && (
              <div className="flex items-center gap-3 pt-3">
                <div className="h-px flex-1 bg-[#e4ebf2]" />
                <span className="text-[11px] font-semibold tracking-wide text-[#c2410c]">PAUSED</span>
                <div className="h-px flex-1 bg-[#e4ebf2]" />
              </div>
            )}
            <div className="border border-[#e4ebf2] rounded-xl bg-white p-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-[#1c2b3a]">{f.clientName || f.slug}</span>
                    <span className={cn("text-[11px] font-semibold rounded-full px-2 py-0.5 border",
                      f.status === "live" ? "bg-[#e7f6ec] text-[#15803d] border-[#bfe3cd]" : "bg-[#fff3e6] text-[#c2410c] border-[#fdba74]")}>
                      {f.status.toUpperCase()}
                    </span>
                    {f.abStatus === "running" && (
                      <button title="Split test is live — click for details"
                        onClick={() => { if (abFor !== f.slug) { setAbFor(f.slug); setAbOrigUrl(f.oldFunnelUrl || ""); void loadAb(f.slug); } }}
                        className="text-[11px] font-semibold rounded-full px-2 py-0.5 border bg-[#f3e8ff] text-[#7c3aed] border-[#d8b4fe] inline-flex items-center gap-1.5 hover:bg-[#ead9fe]">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#7c3aed] animate-pulse" />
                        A/B TEST LIVE
                      </button>
                    )}
                    {f.abStatus === "paused" && (
                      <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 border bg-[#f6f9fc] text-[#697a91] border-[#e4ebf2]">
                        A/B PAUSED
                      </span>
                    )}
                    <a href={f.url} target="_blank" rel="noopener" className="text-xs text-[#0e9c9c] hover:underline inline-flex items-center gap-1">
                      {f.url} <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                  {f.oldFunnelUrl && (
                    <div className="text-[11px] text-[#697a91]">
                      redirect: <a href={f.oldFunnelUrl} target="_blank" rel="noopener" className="hover:underline">{f.oldFunnelUrl}</a>
                      {" → "}
                      <span className="text-[#0e9c9c]">{f.url}</span>
                    </div>
                  )}
                </div>
                <div className="flex-1" />
                <div className="text-right text-xs text-[#697a91]">
                  <div>
                    <b className="text-[#1c2b3a] text-sm">{f.visitors}</b> visitors ·{" "}
                    <button className="hover:underline" onClick={() => { setLeadsFor(leadsFor === f.slug ? null : f.slug); setLeadFilter("all"); void loadLeads(f.slug); }}>
                      <b className="text-[#0e9c9c] text-sm">{f.leads}</b> leads
                    </button>
                    {" · "}
                    <button className="hover:underline" onClick={() => { setLeadsFor(f.slug); setLeadFilter("picked_no_deposit"); void loadLeads(f.slug); }}>
                      <b className="text-[#0e9c9c] text-sm">{f.booked}</b> picked time
                    </button>
                    {" · "}
                    <button className="hover:underline" onClick={() => { setLeadsFor(f.slug); setLeadFilter("deposits"); void loadLeads(f.slug); }}>
                      <b className="text-[#0e9c9c] text-sm">{f.paid}</b> deposits
                    </button>
                  </div>
                  <div>last lead {ago(f.lastLeadAt)} · synced {ago(f.cvSyncedAt)}</div>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <Dot ok={f.hasCalendar} label="calendar" />
                <Dot ok={f.hasFanbasis} label="fanbasis" />
                <Dot ok={f.hasWidget} label="results widget" />
                <Dot ok={f.hasPixel} label="pixel" />
                <div className="flex-1" />
                <button onClick={() => void act("resync", f.slug)} disabled={busy === `resync:${f.slug}`}
                  className="text-xs border border-[#e4ebf2] rounded-lg px-2.5 py-1 hover:bg-[#f6f9fc] inline-flex items-center gap-1">
                  {busy === `resync:${f.slug}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Sync now
                </button>
                <button onClick={() => void act("health", f.slug)} disabled={busy === `health:${f.slug}`}
                  className="text-xs border border-[#e4ebf2] rounded-lg px-2.5 py-1 hover:bg-[#f6f9fc] inline-flex items-center gap-1">
                  {busy === `health:${f.slug}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Stethoscope className="w-3 h-3" />} Health check
                </button>
                <button onClick={() => { setExtrasFor(extrasFor === f.slug ? null : f.slug); setExtrasForm({ fanbasisHtml: "", elfsightId: "", resultImgs: "", metaPixelId: "", oldFunnelUrl: "", ownerName: "" }); }}
                  className={cn("text-xs border rounded-lg px-2.5 py-1",
                    extrasFor === f.slug ? "bg-[#0e9c9c] text-white border-[#0e9c9c] hover:bg-[#0b8383]" : "border-[#e4ebf2] hover:bg-[#f6f9fc]")}>
                  Extras {extrasFor === f.slug ? "▲" : ""}
                </button>
                <button onClick={() => { const open = cvFor === f.slug; setCvFor(open ? null : f.slug); if (!open) setCvForm({ ...f.cv }); }}
                  className={cn("text-xs border rounded-lg px-2.5 py-1",
                    cvFor === f.slug ? "bg-[#0e9c9c] text-white border-[#0e9c9c] hover:bg-[#0b8383]" : "border-[#e4ebf2] hover:bg-[#f6f9fc]")}>
                  Values {cvFor === f.slug ? "▲" : ""}
                </button>
                <button onClick={() => { const open = abFor === f.slug; setAbFor(open ? null : f.slug); if (!open) { setAbOrigUrl(f.oldFunnelUrl || ""); void loadAb(f.slug); } }}
                  className={cn("text-xs border rounded-lg px-2.5 py-1",
                    abFor === f.slug ? "bg-[#0e9c9c] text-white border-[#0e9c9c] hover:bg-[#0b8383]" : "border-[#e4ebf2] hover:bg-[#f6f9fc]")}>
                  Split test {abFor === f.slug ? "▲" : ""}
                </button>
                <button onClick={() => void act("status", f.slug, { status: f.status === "live" ? "paused" : "live" })}
                  disabled={busy === `status:${f.slug}`}
                  className={cn("text-xs rounded-lg px-2.5 py-1 border font-medium",
                    f.status === "live" ? "border-[#fdba74] text-[#c2410c] hover:bg-[#fff3e6]" : "border-[#bfe3cd] text-[#15803d] hover:bg-[#e7f6ec]")}>
                  {f.status === "live" ? "Pause" : "Go live"}
                </button>
              </div>

              {health[f.slug] && (
                <div className="mt-3 border-t border-[#eef2f6] pt-2 grid md:grid-cols-2 gap-1">
                  {health[f.slug].map((c) => (
                    <div key={c.name} className="text-xs flex items-center gap-2">
                      {c.ok ? <Check className="w-3.5 h-3.5 text-[#15803d]" /> : <X className="w-3.5 h-3.5 text-[#b91c1c]" />}
                      <span className="text-[#1c2b3a]">{c.name}</span>
                      <span className="text-[#697a91]">— {c.note}</span>
                    </div>
                  ))}
                </div>
              )}

              {leadsFor === f.slug && (
                <div className="mt-3 border-t border-[#eef2f6] pt-3 grid gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {([["all", "All"], ["lead_only", "Stopped at booking"], ["picked_no_deposit", "Picked time, no deposit"], ["deposits", "Paid"], ["paid_booked", "Paid & booked"]] as [string, string][]).map(([k, label]) => (
                      <button key={k} onClick={() => setLeadFilter(k)}
                        className={cn("text-[11px] rounded-full px-2.5 py-0.5 border",
                          leadFilter === k ? "bg-[#0e9c9c] text-white border-[#0e9c9c]" : "border-[#e4ebf2] hover:bg-[#f6f9fc] text-[#475569]")}>
                        {label}
                      </button>
                    ))}
                    <div className="flex-1" />
                    <button onClick={() => void loadLeads(f.slug)} disabled={leadsBusy}
                      className="text-xs border border-[#e4ebf2] rounded-lg px-2.5 py-1 hover:bg-[#f6f9fc]">
                      {leadsBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : "Refresh"}
                    </button>
                  </div>
                  {!leadRows[f.slug] ? (
                    <div className="text-xs text-[#697a91]"><Loader2 className="w-3.5 h-3.5 animate-spin inline" /> Loading…</div>
                  ) : (
                    (() => {
                      const rowsAll = leadRows[f.slug];
                      const rows = rowsAll.filter((l) =>
                        leadFilter === "all" ? true
                        : leadFilter === "deposits" ? (l.stage === "paid_booked" || l.stage === "paid_no_slot" || l.stage === "paid_followup")
                        : l.stage === leadFilter);
                      return rows.length === 0 ? (
                        <div className="text-xs text-[#697a91]">No leads here yet.</div>
                      ) : (
                        <div className="overflow-x-auto max-h-72 overflow-y-auto">
                          <table className="w-full text-xs">
                            <thead className="text-[#697a91]">
                              <tr className="text-left">
                                <th className="py-1 pr-3 font-medium">Lead</th>
                                <th className="py-1 pr-3 font-medium">Phone</th>
                                <th className="py-1 pr-3 font-medium">Came through</th>
                                <th className="py-1 pr-3 font-medium">Reached</th>
                                <th className="py-1 pr-3 font-medium">Chosen time</th>
                                <th className="py-1 pr-3 font-medium">When</th>
                              </tr>
                            </thead>
                            <tbody>
                              {rows.map((l) => (
                                <tr key={l.id} className="border-t border-[#eef2f6]">
                                  <td className="py-1.5 pr-3 font-medium text-[#1c2b3a]">{l.name}</td>
                                  <td className="py-1.5 pr-3">{l.phone}</td>
                                  <td className="py-1.5 pr-3">{l.variant ?? "direct"}</td>
                                  <td className="py-1.5 pr-3">
                                    <span className={cn("text-[10px] font-semibold rounded-full px-2 py-0.5 border", STAGE_META[l.stage].cls)}>
                                      {STAGE_META[l.stage].label}
                                    </span>
                                  </td>
                                  <td className="py-1.5 pr-3">{l.slot ? new Date(l.slot).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—"}</td>
                                  <td className="py-1.5 pr-3">{new Date(l.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      );
                    })()
                  )}
                </div>
              )}

              {cvFor === f.slug && (
                <div className="mt-3 border-t border-[#eef2f6] pt-3 grid gap-2">
                  <p className="text-[11px] text-[#697a91]">
                    These save straight into the sub-account&rsquo;s GHL custom values and the funnel updates
                    immediately — no need to open GHL.
                  </p>
                  <div className="grid md:grid-cols-2 gap-2">
                    {([
                      ["biz", "Business name"],
                      ["phone", "Business phone"],
                      ["address", "Full address"],
                      ["offer", "Offer (e.g. $200 OFF All Packages)"],
                      ["deposit", "Deposit amount (e.g. $50)"],
                      ["calendarId", "Calendar ID"],
                      ["fanbasisProductId", "Fanbasis product ID"],
                      ["thankYouPath", "Thank-you page path (optional)"],
                      ["igWidget", "Instagram widget link (elf.site)"],
                      ["googleWidget", "Google reviews widget link (elf.site)"],
                    ] as [string, string][]).map(([k, label]) => (
                      <label key={k} className="grid gap-0.5">
                        <span className="text-[10px] font-medium text-[#697a91]">{label}</span>
                        <input value={cvForm[k] ?? ""}
                          onChange={(e) => setCvForm((x) => ({ ...x, [k]: e.target.value }))}
                          className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-xs" />
                      </label>
                    ))}
                  </div>
                  <div>
                    <button
                      onClick={() => {
                        const changed: Record<string, string> = {};
                        for (const [k, v] of Object.entries(cvForm)) {
                          if ((f.cv[k] ?? "") !== v) changed[k] = v;
                        }
                        if (!Object.keys(changed).length) { setToast("Nothing changed"); return; }
                        void act("cvs", f.slug, { values: JSON.stringify(changed) });
                        setCvFor(null);
                      }}
                      disabled={busy === `cvs:${f.slug}`}
                      className="text-xs rounded-lg px-3 py-2 bg-[#0e9c9c] text-white font-medium disabled:opacity-60">
                      {busy === `cvs:${f.slug}` ? "Saving…" : "Save to GHL"}
                    </button>
                  </div>
                </div>
              )}

              {abFor === f.slug && (
                <div className="mt-3 border-t border-[#eef2f6] pt-3">
                  {abBusy && !ab[f.slug] ? (
                    <div className="text-xs text-[#697a91]"><Loader2 className="w-3.5 h-3.5 animate-spin inline" /> Loading…</div>
                  ) : !ab[f.slug]?.experiment ? (
                    <div className="grid gap-2">
                      <div className="flex gap-1.5">
                        <button onClick={() => setAbMode("original")}
                          className={cn("text-xs rounded-lg px-2.5 py-1 border",
                            abMode === "original" ? "bg-[#0e9c9c] text-white border-[#0e9c9c]" : "border-[#e4ebf2] hover:bg-[#f6f9fc]")}>
                          vs original funnel
                        </button>
                        <button onClick={() => setAbMode("versions")}
                          className={cn("text-xs rounded-lg px-2.5 py-1 border",
                            abMode === "versions" ? "bg-[#0e9c9c] text-white border-[#0e9c9c]" : "border-[#e4ebf2] hover:bg-[#f6f9fc]")}>
                          two versions of this funnel
                        </button>
                      </div>
                      <p className="text-[11px] text-[#697a91]">
                        Traffic must arrive at the splitter: point the ad&rsquo;s redirect at{" "}
                        <b>{f.url.replace(`.com/${f.slug}`, `.com/s/${f.slug}`)}</b>. With no test running it simply
                        forwards to the funnel, so it can stay pointed there permanently.
                      </p>
                      {abMode === "original" ? (
                        <div className="grid gap-2">
                          <input id={`ab-orig-${f.slug}`} placeholder="Original funnel URL at its -ab-ghl address (e.g. https://pmu-care.com/their-survey-ab-ghl)"
                            value={abOrigUrl}
                            onChange={(e) => { setAbOrigUrl(e.target.value); setStartVerify(null); }}
                            className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-xs" />
                          <div className="border border-[#e4ebf2] rounded-xl p-3 grid gap-1.5 text-xs">
                            <b className="text-[11px] text-[#1c2b3a]">Start-test SOP — do each step in GHL, tick it, then run the check:</b>
                            <label className="flex items-start gap-2 cursor-pointer text-[#697a91]">
                              <input type="checkbox" className="mt-0.5" checked={sop.renamed}
                                onChange={(e) => { setSop((x) => ({ ...x, renamed: e.target.checked })); setStartVerify(null); }} />
                              <span>1. Rename the original page: add{" "}
                                <CopyChip text="-ab-ghl" onCopied={() => setToast("Copied ✓")} /> to the END of its path
                                (don&rsquo;t retype the whole path)</span>
                            </label>
                            <label className="flex items-start gap-2 cursor-pointer text-[#697a91]">
                              <input type="checkbox" className="mt-0.5" checked={sop.redirect}
                                onChange={(e) => { setSop((x) => ({ ...x, redirect: e.target.checked })); setStartVerify(null); }} />
                              <span>2. URL Redirect (Sites → URL Redirects):{" "}
                                {adUrlFromRenamed(abOrigUrl) ? (
                                  <CopyChip text={adUrlFromRenamed(abOrigUrl).replace(/^https?:\/\/[^/]+/, "")} onCopied={() => setToast("Copied ✓")} />
                                ) : (
                                  <i>paste the -ab-ghl URL above first</i>
                                )}{" "}
                                →{" "}
                                <CopyChip text={f.url.replace(`.com/${f.slug}`, `.com/s/${f.slug}`)} onCopied={() => setToast("Copied ✓")} /></span>
                            </label>
                            <label className="flex items-start gap-2 cursor-pointer text-[#697a91]">
                              <input type="checkbox" className="mt-0.5" checked={sop.values}
                                onChange={(e) => { setSop((x) => ({ ...x, values: e.target.checked })); setStartVerify(null); }} />
                              <span>3. Values filled &amp; health check green</span>
                            </label>
                            <label className="flex items-start gap-2 cursor-pointer text-[#697a91]">
                              <input type="checkbox" className="mt-0.5" checked={sop.workflow}
                                onChange={(e) => { setSop((x) => ({ ...x, workflow: e.target.checked })); setStartVerify(null); }} />
                              <span>4. Workflow <b>CC- Funnel Survey &rarr; (V1/V2/V3)</b>: add a Contact Tag trigger{" "}
                                <CopyChip text="onebox-survey" onCopied={() => setToast("Copied ✓")} />
                                {" "}+ the same tag as an OR condition in the <b>(V3)</b> branch, then Publish
                                (manual — the check can&rsquo;t verify this one)</span>
                            </label>
                            {!startVerify && (
                              <button onClick={() => void verifyStart(f.slug)}
                                disabled={!(sop.renamed && sop.redirect && sop.values && sop.workflow)}
                                className="justify-self-start border border-[#e4ebf2] rounded-lg px-2.5 py-1 hover:bg-[#f6f9fc] disabled:opacity-40 disabled:cursor-not-allowed">
                                Run verification
                              </button>
                            )}
                            {startVerify?.loading && <span className="text-[#697a91]">Checking the live wiring…</span>}
                            {startVerify?.error && <span className="text-[#b91c1c]">{startVerify.error}</span>}
                            {startVerify?.checks && !startVerify.loading && (
                              <>
                                <span className={startVerify.checks.originalReady ? "text-[#15803d]" : "text-[#b91c1c]"}>
                                  {startVerify.checks.originalReady
                                    ? "✓ Original funnel is live at its renamed address"
                                    : `✗ Original funnel: ${startVerify.checks.originalNote}`}
                                </span>
                                <span className={startVerify.checks.redirectLive ? "text-[#15803d]" : "text-[#b91c1c]"}>
                                  {startVerify.checks.redirectLive
                                    ? "✓ Ad URL redirects to the splitter"
                                    : `✗ Ad URL: ${startVerify.checks.redirectNote}`}
                                </span>
                                <span className={startVerify.checks.oneboxReady ? "text-[#15803d]" : "text-[#b91c1c]"}>
                                  {startVerify.checks.oneboxReady
                                    ? "✓ One-box funnel is live and configured"
                                    : `✗ One-box: ${startVerify.checks.oneboxNote}`}
                                </span>
                                {startVerify.adUrl && (
                                  <span className="text-[#697a91] break-all">ad link tested: {startVerify.adUrl}</span>
                                )}
                                {startVerify.ok && startVerify.namedRight === false && (
                                  <span className="text-[#c2410c]">note: the path doesn&rsquo;t end in -ab-ghl — the team won&rsquo;t see the test marker</span>
                                )}
                                <button onClick={() => void verifyStart(f.slug)}
                                  className="justify-self-start border border-[#e4ebf2] rounded-lg px-2.5 py-1 hover:bg-[#f6f9fc]">
                                  Re-check
                                </button>
                              </>
                            )}
                          </div>
                          <button
                            onClick={() => {
                              const el = document.getElementById(`ab-orig-${f.slug}`) as HTMLInputElement | null;
                              const target = (el?.value ?? "").trim();
                              if (!target) { setToast("Add the original funnel URL first"); return; }
                              void abAct(f.slug, {
                                action: "create", slug: f.slug, name: "Original vs One-Box",
                                variants: [
                                  { vkey: "a", label: "Original GHL funnel", kind: "external", target, weight: 50 },
                                  { vkey: "b", label: "One-box funnel", kind: "onebox", weight: 50 },
                                ],
                              });
                            }}
                            disabled={abBusy || !startVerify?.ok}
                            className="justify-self-start text-xs rounded-lg px-3 py-2 bg-[#0e9c9c] text-white font-medium disabled:opacity-40 disabled:cursor-not-allowed">
                            {startVerify?.ok ? "Verified — start 50/50 test" : "Start 50/50 test (verify first)"}
                          </button>
                        </div>
                      ) : (
                        <div className="grid gap-2">
                          <p className="text-[11px] text-[#697a91]">
                            Version A is the funnel exactly as it is. Fill only what Version B should say differently —
                            empty fields stay the same.
                          </p>
                          <div className="grid md:grid-cols-3 gap-2">
                            <input placeholder="Version B name (e.g. Urgency headline)" value={abB.label}
                              onChange={(e) => setAbB((x) => ({ ...x, label: e.target.value }))}
                              className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-xs" />
                            <input placeholder="Headline (Fill Out Our Quiz…)" value={abB.headline}
                              onChange={(e) => setAbB((x) => ({ ...x, headline: e.target.value }))}
                              className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-xs" />
                            <input placeholder="Subheadline ((30 Seconds))" value={abB.sub}
                              onChange={(e) => setAbB((x) => ({ ...x, sub: e.target.value }))}
                              className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-xs" />
                            <input placeholder="Congrats line" value={abB.congrats}
                              onChange={(e) => setAbB((x) => ({ ...x, congrats: e.target.value }))}
                              className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-xs" />
                            <input placeholder="Offer text ($200 OFF …)" value={abB.offer}
                              onChange={(e) => setAbB((x) => ({ ...x, offer: e.target.value }))}
                              className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-xs" />
                            <input placeholder="Booking headline" value={abB.bookingHead}
                              onChange={(e) => setAbB((x) => ({ ...x, bookingHead: e.target.value }))}
                              className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-xs" />
                            <input placeholder="Deposit headline" value={abB.depositHead}
                              onChange={(e) => setAbB((x) => ({ ...x, depositHead: e.target.value }))}
                              className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-xs" />
                          </div>
                          <div>
                            <button
                              onClick={() => {
                                const override: Record<string, string> = {};
                                for (const k of ["headline", "sub", "congrats", "offer", "bookingHead", "depositHead"] as const) {
                                  if (abB[k].trim()) override[k] = abB[k].trim();
                                }
                                if (!Object.keys(override).length) { setToast("Give Version B at least one difference"); return; }
                                void abAct(f.slug, {
                                  action: "create", slug: f.slug, name: "Funnel versions",
                                  variants: [
                                    { vkey: "a", label: "Version A (current)", kind: "onebox", weight: 50 },
                                    { vkey: "b", label: abB.label.trim() || "Version B", kind: "onebox", weight: 50, config_override: override },
                                  ],
                                });
                              }}
                              disabled={abBusy}
                              className="text-xs rounded-lg px-3 py-2 bg-[#0e9c9c] text-white font-medium disabled:opacity-60">
                              Start 50/50 version test
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="grid gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <b className="text-xs text-[#1c2b3a]">{ab[f.slug].experiment!.name}</b>
                        <span className={cn("text-[10px] font-semibold rounded-full px-2 py-0.5 border",
                          ab[f.slug].experiment!.status === "running"
                            ? "bg-[#e7f6ec] text-[#15803d] border-[#bfe3cd]"
                            : "bg-[#fff3e6] text-[#c2410c] border-[#fdba74]")}>
                          {ab[f.slug].experiment!.status.toUpperCase()}
                        </span>
                        <span className="text-[11px] text-[#697a91]">
                          since {new Date(ab[f.slug].experiment!.startedAt).toLocaleDateString()}
                          {ab[f.slug].spendWindow
                            ? ` · spend: ${ab[f.slug].spendWindow}${ab[f.slug].spendOwner ? ` (${ab[f.slug].spendOwner})` : ""}`
                            : " · no spend data — set the ad-spend owner name in Extras"}
                        </span>
                        <div className="flex-1" />
                        <button onClick={() => void loadAb(f.slug)} disabled={abBusy}
                          className="text-xs border border-[#e4ebf2] rounded-lg px-2.5 py-1 hover:bg-[#f6f9fc]">
                          {abBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : "Refresh"}
                        </button>
                        <button onClick={() => {
                          const exp = ab[f.slug].experiment!;
                          if (exp.status === "running") {
                            setEndTest({ slug: f.slug, id: exp.id });
                            setEndChoice("onebox");
                            setEndVerify(null);
                          } else {
                            void abAct(f.slug, { action: "status", id: exp.id, status: "running" });
                          }
                        }}
                          disabled={abBusy}
                          className="text-xs border border-[#e4ebf2] rounded-lg px-2.5 py-1 hover:bg-[#f6f9fc]">
                          {ab[f.slug].experiment!.status === "running" ? "Pause test" : "Resume"}
                        </button>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead className="text-[#697a91]">
                            <tr className="text-left">
                              <th className="py-1 pr-3 font-medium">Variant</th>
                              <th className="py-1 pr-3 font-medium">Visitors</th>
                              <th className="py-1 pr-3 font-medium">Leads</th>
                              <th className="py-1 pr-3 font-medium">Lead rate</th>
                              <th className="py-1 pr-3 font-medium">Picked time</th>
                              <th className="py-1 pr-3 font-medium">Deposits</th>
                              <th className="py-1 pr-3 font-medium">AI deposits</th>
                              <th className="py-1 pr-3 font-medium">Pick rate</th>
                              <th className="py-1 pr-3 font-medium">Spend</th>
                              <th className="py-1 pr-3 font-medium">Cost / booking</th>
                            </tr>
                          </thead>
                          <tbody>
                            {ab[f.slug].variants.map((v) => {
                              const best = ab[f.slug].variants
                                .filter((x) => x.costPerBooking != null)
                                .sort((a, b) => (a.costPerBooking! - b.costPerBooking!))[0];
                              const isBest = !!best && best.vkey === v.vkey && ab[f.slug].variants.filter((x) => x.costPerBooking != null).length > 1;
                              return (
                                <tr key={v.vkey} className="border-t border-[#eef2f6]">
                                  <td className="py-1.5 pr-3">
                                    <span className="text-[#1c2b3a] font-medium">{v.label}</span>
                                    {isBest && <span className="ml-1.5 text-[10px] font-semibold text-[#15803d]">best</span>}
                                    {v.kind === "onebox" && (
                                      <a href={`${f.url}?ob_e=${ab[f.slug].experiment!.id}&ob_v=${v.vkey}`} target="_blank" rel="noopener"
                                        className="ml-1.5 text-[10px] text-[#0e9c9c] hover:underline">preview</a>
                                    )}
                                    {!!v.overrides?.length && (
                                      <div className="text-[10px] text-[#697a91]">changes: {v.overrides.join(", ")}</div>
                                    )}
                                  </td>
                                  <td className="py-1.5 pr-3">{v.visitors}</td>
                                  <td className="py-1.5 pr-3">
                                    {v.leads != null ? v.leads
                                      : v.kind === "external" ? <span className="text-[10px] text-[#97a5b8]" title="This side's form-fills live in GHL contacts — not visible from here (not zero)">in GHL</span> : "—"}
                                  </td>
                                  <td className="py-1.5 pr-3">{v.leadRate != null ? `${v.leadRate}%` : "—"}</td>
                                  <td className="py-1.5 pr-3">{v.picked ?? "—"}</td>
                                  <td className="py-1.5 pr-3">
                                    {v.deposits != null ? v.deposits
                                      : v.kind === "external" ? <span className="text-[10px] text-[#97a5b8]" title="This side's deposits live in Fanbasis — not visible from here (not zero)">in Fanbasis</span> : "—"}
                                  </td>
                                  <td className="py-1.5 pr-3 text-[#7c3aed] font-medium">{v.aiDeposits != null ? v.aiDeposits : "—"}</td>
                                  <td className="py-1.5 pr-3">{v.pickRate != null ? `${v.pickRate}%` : "—"}</td>
                                  <td className="py-1.5 pr-3">{v.spend != null ? `$${v.spend}` : "—"}</td>
                                  <td className="py-1.5 pr-3 font-semibold text-[#1c2b3a]">
                                    {v.costPerBooking != null ? `$${v.costPerBooking}` : "—"}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <p className="text-[10px] text-[#697a91]">
                        The funnel: visitors → leads → picked a date &amp; time → paid the deposit. Both sides are
                        compared at &ldquo;picked a time&rdquo;: for the original funnel that&rsquo;s its GHL calendar
                        appointments (booking happens before the deposit there). Deposits count <i>funnel-native</i>
                        auto-bookings only: paid on the funnel page itself (one-box), or while the 10-minute slot
                        hold was alive (original funnel — within 15 min of booking). Deposits the AI collects later
                        by text are excluded on both sides. Spend is this client&rsquo;s ad spend split by each side&rsquo;s
                        share of visitors — the same ads feed both, so spend follows the traffic.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {extrasFor === f.slug && (
                <div className="mt-3 border-t border-[#eef2f6] pt-3 grid gap-2">
                  <p className="text-[11px] text-[#697a91]">
                    Leave a field empty to keep its current value. Instagram widget accepts the Elfsight ID, the elf.site link, or the whole embed code.
                  </p>
                  <textarea placeholder="Fanbasis checkout block (paste the whole custom-code block from the client's -last-step page)"
                    value={extrasForm.fanbasisHtml} onChange={(e) => setExtrasForm((x) => ({ ...x, fanbasisHtml: e.target.value }))}
                    rows={3} className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-xs font-mono" />
                  <div className="grid md:grid-cols-3 gap-2">
                    <input placeholder="Instagram widget (Elfsight ID / link / code)" value={extrasForm.elfsightId}
                      onChange={(e) => setExtrasForm((x) => ({ ...x, elfsightId: e.target.value }))}
                      className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-xs" />
                    <input placeholder="Result image URLs, comma-separated" value={extrasForm.resultImgs}
                      onChange={(e) => setExtrasForm((x) => ({ ...x, resultImgs: e.target.value }))}
                      className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-xs" />
                    <input placeholder="Meta pixel ID" value={extrasForm.metaPixelId}
                      onChange={(e) => setExtrasForm((x) => ({ ...x, metaPixelId: e.target.value }))}
                      className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-xs" />
                  </div>
                  <input placeholder="Old funnel URL this one replaces (shows the redirect from → to line)"
                    value={extrasForm.oldFunnelUrl}
                    onChange={(e) => setExtrasForm((x) => ({ ...x, oldFunnelUrl: e.target.value }))}
                    className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-xs" />
                  <input placeholder="Ad-spend owner name, exactly as in the Performance tab (e.g. Ivan Androsov)"
                    value={extrasForm.ownerName}
                    onChange={(e) => setExtrasForm((x) => ({ ...x, ownerName: e.target.value }))}
                    className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-xs" />
                  <div>
                    <button onClick={() => {
                      const payload: Record<string, string> = {};
                      if (extrasForm.fanbasisHtml.trim()) payload.fanbasisHtml = extrasForm.fanbasisHtml;
                      if (extrasForm.elfsightId.trim()) payload.elfsightId = extrasForm.elfsightId;
                      if (extrasForm.resultImgs.trim()) payload.resultImgs = extrasForm.resultImgs;
                      if (extrasForm.metaPixelId.trim()) payload.metaPixelId = extrasForm.metaPixelId;
                      if (extrasForm.oldFunnelUrl.trim()) payload.oldFunnelUrl = extrasForm.oldFunnelUrl;
                      if (extrasForm.ownerName.trim()) payload.ownerName = extrasForm.ownerName;
                      void act("extras", f.slug, payload);
                      setExtrasFor(null);
                    }} disabled={busy === `extras:${f.slug}`}
                      className="flex items-center gap-1.5 text-xs bg-[#0e9c9c] text-white rounded-lg px-3 py-1.5 hover:bg-[#0b8383]">
                      <Save className="w-3.5 h-3.5" /> Save extras
                    </button>
                  </div>
                </div>
              )}
            </div>
            </Fragment>
          ))}
        </div>
      )}

      {endTest && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
          onClick={() => setEndTest(null)}>
          <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full p-5 grid gap-3"
            onClick={(e) => e.stopPropagation()}>
            <b className="text-sm text-[#1c2b3a]">Pause this split test — where should traffic go?</b>

            <label className={cn("flex items-start gap-2.5 border rounded-xl p-3 cursor-pointer",
              endChoice === "onebox" ? "border-[#0e9c9c] bg-[#f0fafa]" : "border-[#e4ebf2]")}>
              <input type="radio" className="mt-0.5" checked={endChoice === "onebox"}
                onChange={() => { setEndChoice("onebox"); setEndVerify(null); }} />
              <span className="text-xs text-[#697a91]">
                <b className="block text-[#1c2b3a]">Everything to the one-box</b>
                No GHL changes needed. With the test paused, the splitter sends 100% of visitors
                (new and returning) to the one-box funnel — the ad link keeps working as is.
              </span>
            </label>

            <label className={cn("flex items-start gap-2.5 border rounded-xl p-3 cursor-pointer",
              endChoice === "original" ? "border-[#0e9c9c] bg-[#f0fafa]" : "border-[#e4ebf2]")}>
              <input type="radio" className="mt-0.5" checked={endChoice === "original"}
                onChange={() => { setEndChoice("original"); setEndVerify(null); }} />
              <span className="text-xs text-[#697a91]">
                <b className="block text-[#1c2b3a]">Back to the original GHL funnel</b>
                Do the two GHL steps first — <b>1)</b> delete the URL Redirect on the ad path,
                then <b>2)</b> rename the page back (remove <code>-ab-ghl</code>).
                Both are checked live before you can pause.
              </span>
            </label>

            {endChoice === "original" && (
              <div className="border border-[#e4ebf2] rounded-xl p-3 grid gap-1.5 text-xs">
                {!endVerify && (
                  <button onClick={() => void verifyRevert(endTest.id)}
                    className="justify-self-start border border-[#e4ebf2] rounded-lg px-2.5 py-1 hover:bg-[#f6f9fc]">
                    Check GHL now
                  </button>
                )}
                {endVerify?.loading && <span className="text-[#697a91]">Checking the ad link…</span>}
                {endVerify?.error && <span className="text-[#b91c1c]">{endVerify.error}</span>}
                {endVerify && !endVerify.loading && !endVerify.error && (
                  endVerify.applicable === false ? (
                    <span className="text-[#697a91]">
                      This test has no original-funnel side (it compares two one-box versions) — nothing to verify in GHL.
                    </span>
                  ) : (
                    <>
                      <span className={endVerify.redirectGone ? "text-[#15803d]" : "text-[#b91c1c]"}>
                        {endVerify.redirectGone
                          ? "✓ Step 1 — URL Redirect deleted"
                          : "✗ Step 1 — the ad link still lands on the splitter. Delete the redirect in GHL → Sites → URL Redirects, then re-check."}
                      </span>
                      <span className={endVerify.pageBack ? "text-[#15803d]" : endVerify.redirectGone ? "text-[#b91c1c]" : "text-[#697a91]"}>
                        {endVerify.pageBack
                          ? "✓ Step 2 — the original page is back on the ad path"
                          : endVerify.redirectGone
                            ? "✗ Step 2 — the ad link is a dead 404: ad clicks are being wasted right now. Rename the page path back (remove -ab-ghl), then re-check."
                            : "· Step 2 — checked once step 1 passes"}
                      </span>
                      <span className="text-[#697a91] break-all">checked: {endVerify.adUrl}</span>
                      <button onClick={() => void verifyRevert(endTest.id)}
                        className="justify-self-start border border-[#e4ebf2] rounded-lg px-2.5 py-1 hover:bg-[#f6f9fc]">
                        Re-check
                      </button>
                    </>
                  )
                )}
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setEndTest(null)}
                className="text-xs border border-[#e4ebf2] rounded-lg px-3 py-1.5 hover:bg-[#f6f9fc]">
                Cancel
              </button>
              <button
                disabled={abBusy || (endChoice === "original"
                  && !(endVerify && !endVerify.loading && !endVerify.error
                    && (endVerify.applicable === false || (endVerify.redirectGone && endVerify.pageBack))))}
                onClick={() => { void abAct(endTest.slug, { action: "status", id: endTest.id, status: "paused" }); setEndTest(null); }}
                className="text-xs bg-[#0e9c9c] text-white rounded-lg px-3 py-1.5 hover:bg-[#0b8383] disabled:opacity-40 disabled:cursor-not-allowed">
                Confirm &amp; pause
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
