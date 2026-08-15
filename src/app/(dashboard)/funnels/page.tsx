"use client";
import { useCallback, useEffect, useState } from "react";
import { useUser } from "@/lib/hooks/useUser";
import { Loader2, RefreshCw, Plus, ExternalLink, Stethoscope, Check, X, Save } from "lucide-react";
import { cn } from "@/lib/utils";

// Funnels — the one-box funnels hosted on Vercel: which client has one,
// its live URL, health, leads and bookings. Content itself is edited in
// each sub-account's GHL custom values; this tab manages existence,
// status and the per-client extras (Fanbasis block, widget, pixel).

type AbVariant = {
  vkey: string; label: string; kind: string; target: string | null; weight: number;
  overrides?: string[];
  deposits: number | null;
  visitors: number; leads: number | null; booked: number | null;
  bookRate: number | null; spend: number | null; costPerBooking: number | null;
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
  visitors: number;
  leads: number;
  paid: number; booked: number; lastLeadAt: string | null;
};
type HealthCheck = { name: string; ok: boolean; note: string };

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
  const [extrasForm, setExtrasForm] = useState({ fanbasisHtml: "", elfsightId: "", resultImgs: "", metaPixelId: "", oldFunnelUrl: "", ownerName: "" });
  const [toast, setToast] = useState<string | null>(null);
  const [abFor, setAbFor] = useState<string | null>(null);
  const [abMode, setAbMode] = useState<"original" | "versions">("original");
  const [abB, setAbB] = useState({ label: "Version B", headline: "", sub: "", congrats: "", offer: "", bookingHead: "", depositHead: "" });
  const [ab, setAb] = useState<Record<string, AbResult>>({});
  const [abBusy, setAbBusy] = useState(false);

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
      else setToast(action === "resync" ? "Synced from GHL ✓" : "Saved ✓");
      if (action !== "health") await load();
    } finally { setBusy(null); }
  }

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
      setAddNote(`Created ${j.url} — ${j.pixelNote}${j.calendarId ? "" : " · ⚠ no calendar id in custom values"}`);
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
          {funnels.map((f) => (
            <div key={f.slug} className="border border-[#e4ebf2] rounded-xl bg-white p-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-[#1c2b3a]">{f.clientName || f.slug}</span>
                    <span className={cn("text-[11px] font-semibold rounded-full px-2 py-0.5 border",
                      f.status === "live" ? "bg-[#e7f6ec] text-[#15803d] border-[#bfe3cd]" : "bg-[#fff3e6] text-[#c2410c] border-[#fdba74]")}>
                      {f.status.toUpperCase()}
                    </span>
                  </div>
                  <a href={f.url} target="_blank" rel="noopener" className="text-xs text-[#0e9c9c] hover:underline inline-flex items-center gap-1">
                    {f.url} <ExternalLink className="w-3 h-3" />
                  </a>
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
                    <b className="text-[#1c2b3a] text-sm">{f.visitors}</b> visitors · <b className="text-[#1c2b3a] text-sm">{f.leads}</b> leads
                    {" · "}<b className="text-[#1c2b3a] text-sm">{f.booked}</b> booked · <b className="text-[#1c2b3a] text-sm">{f.paid}</b> deposits
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
                  className="text-xs border border-[#e4ebf2] rounded-lg px-2.5 py-1 hover:bg-[#f6f9fc]">
                  Extras
                </button>
                <button onClick={() => { const open = abFor === f.slug; setAbFor(open ? null : f.slug); if (!open) void loadAb(f.slug); }}
                  className="text-xs border border-[#e4ebf2] rounded-lg px-2.5 py-1 hover:bg-[#f6f9fc]">
                  Split test
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
                        <div className="grid md:grid-cols-2 gap-2">
                          <input id={`ab-orig-${f.slug}`} placeholder="Original funnel URL (e.g. https://pmu-care.com/care-pmu-survey-test-old)"
                            defaultValue={f.oldFunnelUrl || ""}
                            className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-xs" />
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
                            disabled={abBusy}
                            className="text-xs rounded-lg px-3 py-2 bg-[#0e9c9c] text-white font-medium disabled:opacity-60">
                            Start 50/50 test
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
                        <button onClick={() => void abAct(f.slug, { action: "status", id: ab[f.slug].experiment!.id,
                          status: ab[f.slug].experiment!.status === "running" ? "paused" : "running" })}
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
                              <th className="py-1 pr-3 font-medium">Deposits</th>
                              <th className="py-1 pr-3 font-medium">Booked</th>
                              <th className="py-1 pr-3 font-medium">Book rate</th>
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
                                  <td className="py-1.5 pr-3">{v.leads ?? "—"}</td>
                                  <td className="py-1.5 pr-3">{v.deposits ?? "—"}</td>
                                  <td className="py-1.5 pr-3">{v.booked ?? "—"}</td>
                                  <td className="py-1.5 pr-3">{v.bookRate != null ? `${v.bookRate}%` : "—"}</td>
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
                        Spend is this client&rsquo;s ad spend split by each side&rsquo;s share of visitors — the same ads
                        feed both, so spend follows the traffic. The original funnel&rsquo;s bookings are counted from the
                        GHL calendar (appointments the one-box didn&rsquo;t create); its leads and deposits live in
                        GHL/Fanbasis, which is why those show &ldquo;—&rdquo;.
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
          ))}
        </div>
      )}
    </div>
  );
}
