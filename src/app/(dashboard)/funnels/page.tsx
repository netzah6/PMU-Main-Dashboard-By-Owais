"use client";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUser } from "@/lib/hooks/useUser";
import { Loader2, RefreshCw, Plus, ExternalLink, Stethoscope, Check, X, Search, Trash2 } from "lucide-react";
import { SERVICE_OPTIONS } from "@/lib/onboarding-steps";
import { cn } from "@/lib/utils";
import type { StatsWindow } from "@/lib/onebox-insights";

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
  hasCalendar: boolean; hasFanbasis: boolean; hasWidget: boolean; hasPixel: boolean; pixelId?: string;
  oldFunnelUrl: string;
  adRedirect: "" | "yes" | "no";
  redirectVerifiedAt: string | null;
  cv: Record<string, string>;
  visitors: number;
  leads: number;
  paid: number; booked: number; lastLeadAt: string | null;
  abStatus: string | null;
  template: string;
  /* The client's program from the Clients Master sheet — the same row the
     Clients tab edits, so both tabs always show (and change) one truth. */
  program: { version: string; sheetRow: number; ownerName: string; matches: number; via: "exact" | "prefix" } | null;
  /* What the splitter routes by: the NEWEST running experiment — or, with
     none running, the newest paused one that still has an original-funnel
     side (so sending traffic back is a resume, not a re-setup). null =
     this client has never had a test against the original. */
  traffic: {
    expId: number; status: "running" | "paused";
    variants: { vkey: string; label: string; kind: string; weight: number; target: string | null }[];
  } | null;
};

/* The card chip's one-line truth. With no RUNNING experiment the splitter
   forwards every visitor straight to the one-box funnel, whatever old
   paused tests exist — so anything but "running" reads 100% → One-box. */
function trafficSummary(t: Funnel["traffic"]): string {
  if (!t || t.status !== "running") return "100% → One-box";
  const active = t.variants.filter((v) => v.weight > 0);
  if (!active.length) return "no traffic weights";
  const total = active.reduce((s, v) => s + v.weight, 0);
  if (active.length === 1) return `100% → ${active[0].label}`;
  return active.map((v) => `${Math.round((v.weight / total) * 100)}% ${v.label}`).join(" · ");
}
/* The engine's standard six survey questions in the dashboard-editable
   format — inserted into the editor so a client-specific tweak starts
   from the real thing instead of a blank box. */
const DEFAULT_SURVEY_TEMPLATE = [
  "Which Area(s) Would You Like Treated? | Lips; Eyebrows",
  "Have You Ever Had Permanent Makeup Before? | Yes; No",
  "What Age Group Are You In? | 18-24; 24-30; 30-36; 36-42; 42-54; 54-65; 65+",
  "Our Address is {address}. Is This commutable for you? | Yes; No",
  "On A Scale From 1-10 How Serious Are You About Getting This Treatment? | 0-2; 3-6; 7-9; 10 I Want This Treatment!",
  "Would you like a FREE Aftercare Kit? | Yes; No",
].join("\n");

/* Survey rows for the Start Setup manager. A "// " prefix in the stored
   value marks a question that is toggled OFF (the engine skips it). */
type SurveyRow = { text: string; opts: string; off: boolean };
function parseSurvey(raw: string): SurveyRow[] {
  return raw.split(/\r?\n/).map((line) => {
    const off = /^\s*\/\//.test(line);
    const body = line.replace(/^\s*\/\/\s?/, "");
    const bar = body.indexOf("|");
    if (bar < 0) return null;
    const text = body.slice(0, bar).trim();
    const opts = body.slice(bar + 1).trim();
    return text && opts ? { text, opts, off } : null;
  }).filter((r): r is SurveyRow => r !== null);
}
function serializeSurvey(rows: SurveyRow[]): string {
  return rows
    .filter((r) => r.text.trim() && r.opts.trim())
    .map((r) => (r.off ? "// " : "") + r.text.trim() + " | " + r.opts.trim())
    .join("\n");
}

type HealthCheck = { name: string; ok: boolean; note: string };

/* Card-list grouping: V3 first (where the focus is), then V2.3, V1, the
   demo, and anything the sheet can't match; B2B always dead last. */
function programRank(f: Funnel): number {
  if (f.template === "b2b") return 9;
  if (f.slug === "demo-v3") return 6;
  if (!f.program) return 5;
  if (f.program.version === "(V3)") return 0;
  if (f.program.version === "(V2.3)") return 1;
  if (f.program.version === "(V1)") return 2;
  return 4;
}
function programSection(f: Funnel): string {
  if (f.template === "b2b") return "";
  if (f.slug === "demo-v3") return "DEMO";
  if (!f.program) return "NOT MATCHED TO THE CLIENTS SHEET";
  if (f.program.version === "(V3)") return "V3 CLIENTS";
  if (f.program.version === "(V2.3)") return "V2.3 CLIENTS";
  if (f.program.version === "(V1)") return "V1 CLIENTS";
  return `${f.program.version || "NO VERSION"} CLIENTS`;
}

/* One optimizer flag: the problem, the evidence, the proposed fix — and
   whatever the human decided about it. */
type Insight = {
  id: number; slug: string; clientName: string; kind: string; status: string;
  problem: string; why: string; solution: string;
  deny_reason: string | null; user_suggestion: string | null;
  decided_at: string | null; created_at: string;
};

/* Click-to-copy pill for SOP values — the exact string, one click. */
/* Photo slot of the full setup form: upload to the dashboard's public
   bucket (same endpoint as the Onboarding tab) or paste a URL; the URL is
   what goes into the GHL custom value the funnel renders. */
function ImageField({ value, onChange, onToast }: { value: string; onChange: (url: string) => void; onToast: (m: string) => void }) {
  const [uploading, setUploading] = useState(false);
  const pick = async (file: File | null) => {
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/onboarding/upload", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Upload failed");
      onChange(json.url);
    } catch (e) {
      onToast(`Upload failed: ${String(e).replace("Error: ", "")}`);
    } finally { setUploading(false); }
  };
  return (
    <div className="flex items-center gap-1.5">
      {value ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={value} alt="" className="w-9 h-9 rounded-lg object-cover border border-[#e4ebf2] shrink-0" />
      ) : null}
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder="Upload or paste an image URL"
        className="flex-1 min-w-0 border border-[#e4ebf2] rounded-lg px-3 py-2 text-xs" />
      <label className={cn("shrink-0 px-2.5 py-2 rounded-lg text-xs font-semibold cursor-pointer border",
        uploading ? "opacity-50 pointer-events-none border-[#e4ebf2] text-[#8595a8]" : "border-[#bfe6e2] text-[#0b7f7f] hover:bg-[#f0fbfa]")}>
        {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin inline" /> : "Upload"}
        <input type="file" accept="image/*" className="hidden" onChange={(e) => void pick(e.target.files?.[0] ?? null)} />
      </label>
      {value && (
        <button type="button" onClick={() => onChange("")} title="Remove" className="shrink-0 p-1.5 rounded text-[#94a3b8] hover:text-[#e11d48]"><Trash2 className="w-3.5 h-3.5" /></button>
      )}
    </div>
  );
}

/* The chip itself flashes green "Copied ✓" for a moment, so the copy is
   confirmed right where the click happened (user, 2026-09-19). */
function CopyChip({ text, label, onCopied }: { text: string; label?: string; onCopied: () => void }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title={`Copy: ${text}`}
      onClick={(e) => {
        e.preventDefault();
        void navigator.clipboard.writeText(text).then(() => {
          onCopied();
          setDone(true);
          window.setTimeout(() => setDone(false), 1400);
        });
      }}
      className={cn("inline-flex items-center gap-1 align-middle font-mono text-[11px] border rounded-md px-1.5 py-0.5 cursor-copy max-w-[300px] transition-colors duration-200",
        done ? "bg-[#e7f6ec] text-[#15803d] border-[#86d3a3] scale-105" : "bg-[#f0f6f6] text-[#0b7285] border-[#bfe3e3] hover:bg-[#e2f1f1]")}>
      <span className="truncate">{done ? "Copied ✓" : (label ?? text)}</span>
      {done ? (
        <Check className="w-3 h-3 shrink-0" />
      ) : (
        <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      )}
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
  /* Compact: a green check shows only the icon (hover for the name) —
     healthy is the norm and doesn't need to shout. A failing check keeps
     its label visible so problems still jump out. */
  if (ok) return (
    <span title={label} className="inline-flex items-center rounded-full border px-1 py-0.5 bg-[#e7f6ec] text-[#15803d] border-[#bfe3cd]">
      <Check className="w-3 h-3" />
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium rounded-full border px-2 py-0.5 bg-[#fef2f2] text-[#b91c1c] border-[#fca5a5]">
      <X className="w-3 h-3" />{label}
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
  footnote?: string;
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
      {footnote && <p className="mt-2 text-[10px] text-[#697a91]">{footnote}</p>}
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
  /* The slug follows the client name until the user types in the slug box
     themselves. It used to lock on the FIRST name typed, so renaming the
     client afterwards left a stranger's slug (Eye Select Beauty was
     created as "the-healing-design", 2026-09-19). */
  const [slugTouched, setSlugTouched] = useState(false);
  /* "Saved ✓" shown on the Save button itself for a moment after a
     successful write, so the confirmation is where the click happened. */
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  /* Step 1's "New client — full setup form": the rest of the old GHL
     "CC - 🎀 Funnel Form (V2 + V3)" (owner, links, V3 details, prices,
     photos). Existing clients already have these values, so it stays
     folded unless the team opens it. */
  const [fullForm, setFullForm] = useState(false);
  const slugify = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  // Search line at the top — dozens of funnel boxes now (user, 2026-09-14).
  const [search, setSearch] = useState("");
  const [addNote, setAddNote] = useState<string | null>(null);
  const [surveyRows, setSurveyRows] = useState<SurveyRow[]>([]);
  const [surveyDirty, setSurveyDirty] = useState(false);
  const surveyDragIdx = useRef<number | null>(null);
  const [cvFor, setCvFor] = useState<string | null>(null);
  const [leadsFor, setLeadsFor] = useState<string | null>(null);
  const [leadRows, setLeadRows] = useState<Record<string, LeadRow[]>>({});
  const [leadFilter, setLeadFilter] = useState<string>("all");
  const [leadsBusy, setLeadsBusy] = useState(false);
  const [cvForm, setCvForm] = useState<Record<string, string>>({});
  const [extrasForm, setExtrasForm] = useState({ fanbasisHtml: "", elfsightId: "", resultImgs: "", metaPixelId: "", oldFunnelUrl: "", ownerName: "" });
  /* Start Setup step 5 — redirect the ad link onto this funnel? The choice
     is saved on the funnel (extras.adRedirect); the verification result is
     per open panel and re-checked live each time. */
  const [redirectChoice, setRedirectChoice] = useState<"" | "yes" | "no">("");
  const [adUrlForm, setAdUrlForm] = useState("");
  /* Tick-boxes for the three GHL steps of the redirect SOP; Verify unlocks
     once all three are ticked (same pattern as the split-test SOP). The
     workflow tag step can't be machine-checked, so the box is the record. */
  const [sop5, setSop5] = useState({ renamed: false, redirect: false, workflow: false });
  const [redirectVerify, setRedirectVerify] = useState<{ loading?: boolean; error?: string; ok?: boolean; adUrl?: string; target?: string;
    checks?: { redirectLive: boolean; redirectNote: string; originalKept: boolean; originalNote: string } } | null>(null);
  const [pixelOther, setPixelOther] = useState(false);
  /* Pixels in use across all funnels. Shared ones (2+ funnels) are the
     agency's template pixels — named "PMU For all (A)", "(B)", … by how many
     funnels ride on them; a pixel used by one funnel is named after that
     client. */
  const pixelOptions = useMemo(() => {
    const use = new Map<string, { n: number; who: string }>();
    for (const x of funnels) {
      const id = (x.pixelId ?? "").replace(/\D/g, "");
      if (!id) continue;
      const u = use.get(id) ?? { n: 0, who: x.clientName };
      u.n += 1; use.set(id, u);
    }
    const shared = [...use.entries()].filter(([, u]) => u.n >= 2).sort((a, b) => b[1].n - a[1].n);
    const single = [...use.entries()].filter(([, u]) => u.n < 2).sort((a, b) => a[1].who.localeCompare(b[1].who));
    const out: { id: string; label: string }[] = [];
    shared.forEach(([id, u], i) => out.push({ id, label: `PMU For all (${String.fromCharCode(65 + i)}) — ${id} · ${u.n} funnels` }));
    single.forEach(([id, u]) => out.push({ id, label: `${u.who} — ${id}` }));
    return out;
  }, [funnels]);
  const pixelLabel = (id: string) => pixelOptions.find((o) => o.id === id)?.label ?? id;
  /* What the list shows: sorted B2C-first as before, narrowed by the search
     line; a coach never sees the agency's B2B funnel. */
  const visibleFunnels = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...funnels]
      .filter((f) => role === "admin" || f.template !== "b2b")
      .filter((f) => !q || `${f.clientName} ${f.slug}`.toLowerCase().includes(q))
      .sort((a, b) =>
        programRank(a) - programRank(b) ||
        Number(b.status === "live") - Number(a.status === "live") ||
        (a.clientName || a.slug).localeCompare(b.clientName || b.slug));
  }, [funnels, search, role]);
  const pixelChoice = (typed: string, current: string) =>
    pixelOther ? "__other" : !typed ? "__keep" : pixelOptions.some((o) => o.id === typed && typed !== current) ? typed : "__other";
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
  /* Which client the current SOP verification belongs to — the start
     button must never unlock from another card's passed check. */
  const [verifySlug, setVerifySlug] = useState<string | null>(null);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [b2bOverviewOpen, setB2bOverviewOpen] = useState(false);
  const [startVerify, setStartVerify] = useState<{ loading?: boolean; ok?: boolean; adUrl?: string; namedRight?: boolean;
    checks?: { originalReady: boolean; originalNote: string; redirectLive: boolean; redirectNote: string;
      oneboxReady: boolean; oneboxNote: string };
    error?: string } | null>(null);

  /* The full-page spinner is for the FIRST load only. A refresh after a
     save used to swap the whole list for the spinner, which unmounted the
     open Start Setup panel and threw the page back to the top (user,
     2026-09-20). Background refreshes now update the list in place. */
  const loadedOnce = useRef(false);
  const load = useCallback(async () => {
    if (!loadedOnce.current) setLoading(true);
    try {
      const r = await fetch("/api/onebox/admin");
      const j = await r.json();
      setFunnels(j.funnels ?? []);
      loadedOnce.current = true;
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  /* Always-on performance overview (post-A/B): funnel-wide stats per
     live client for a 7/14/30-day window, no experiment required. 30 is
     the default — short windows leave low-traffic clients with 0 visitors
     and therefore no rates to show. */
  type StatRow = { slug: string; clientName: string; visitors: number; leads: number; leadRate: number | null;
    picked: number; pickRate: number | null; deposits: number; aiDeposits: number; spend: number | null; costPerBooking: number | null };
  const [statsOpen, setStatsOpen] = useState(false);
  const [statsWin, setStatsWin] = useState<StatsWindow>(30);
  const [stats, setStats] = useState<StatRow[] | null>(null);
  const [page1Map, setPage1Map] = useState<Record<string, number>>({});
  const [statsLoading, setStatsLoading] = useState(false);
  const loadStats = useCallback(async (win: StatsWindow) => {
    setStatsLoading(true);
    try {
      const r = await fetch(`/api/onebox/admin?stats=${win}`);
      const j = await r.json();
      setStats(j.stats ?? []);
      setPage1Map(j.page1 ?? {});
    } finally { setStatsLoading(false); }
  }, []);

  /* Optimizer inbox: data-backed flags per funnel, each waiting for an
     explicit approve or deny. A deny must carry a reason or a better idea —
     that's what keeps the same flag from coming straight back. */
  const [insights, setInsights] = useState<{ open: Insight[]; decided: Insight[] } | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [decideBusy, setDecideBusy] = useState<number | null>(null);
  const [denyFor, setDenyFor] = useState<number | null>(null);
  const [denyReason, setDenyReason] = useState("");
  const [denySuggestion, setDenySuggestion] = useState("");
  const [showDecided, setShowDecided] = useState(false);
  const [optimizerOpen, setOptimizerOpen] = useState(false); // closed by default (user, 2026-09-15)

  /* Program (V3/V2.3/V1) switcher — writes the Version column of the same
     Clients Master row the Clients tab edits, sheet write-back included,
     so the two tabs can never disagree. */
  const [progFor, setProgFor] = useState<string | null>(null);
  const [progBusy, setProgBusy] = useState<string | null>(null);
  const saveProgram = useCallback(async (f: Funnel, newVersion: string) => {
    if (!f.program || newVersion === f.program.version) { setProgFor(null); return; }
    setProgBusy(f.slug);
    try {
      const r = await fetch("/api/sync/clients_master", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowNumber: f.program.sheetRow, rowData: { Version: newVersion }, columns: ["Version"] }),
      });
      const j = await r.json();
      if (!r.ok) { setToast(`Version save failed: ${j.error ?? r.status}`); return; }
      setToast(j.sheetsUpdated
        ? `${f.clientName || f.slug}: Version → ${newVersion} — Clients sheet updated ✓`
        : `${f.clientName || f.slug}: Version → ${newVersion} (sheet write-back failed — check the Clients tab)`);
      setProgFor(null);
      await load();
    } finally { setProgBusy(null); }
  }, [load]);
  const loadInsights = useCallback(async () => {
    try {
      const r = await fetch("/api/onebox/insights");
      const j = await r.json();
      if (!j.error) setInsights({ open: j.open ?? [], decided: j.decided ?? [] });
    } catch { /* panel just stays empty */ }
  }, []);
  useEffect(() => { void loadInsights(); }, [loadInsights]);
  const scanNow = useCallback(async () => {
    setScanBusy(true);
    try {
      const r = await fetch("/api/onebox/insights", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "scan" }),
      });
      const j = await r.json();
      if (j.error) { setToast(`Scan failed: ${j.error}`); return; }
      setToast(j.created ? `Scan done — ${j.created} new flag${j.created === 1 ? "" : "s"}` : "Scan done — nothing new to flag");
      await loadInsights();
    } finally { setScanBusy(false); }
  }, [loadInsights]);
  /* The inline A/B panel on the performance table: proposed copy when no
     test runs, live per-side numbers + keep-winner buttons while it does. */
  type AbPanel = {
    test: { expId: number; startedAt: string; visA: number; visB: number; leadsA: number; leadsB: number; rateA: number | null; rateB: number | null; override: Record<string, string> } | null;
    proposal: Record<string, string>;
    current: { headline: string; congrats: string };
  };
  const [abPanelFor, setAbPanelFor] = useState<string | null>(null);
  const [abPanel, setAbPanel] = useState<AbPanel | null>(null);
  const [abPanelBusy, setAbPanelBusy] = useState(false);
  const [abDraft, setAbDraft] = useState({ headline: "", congrats: "" });
  const openAbPanel = useCallback(async (slug: string) => {
    if (abPanelFor === slug) { setAbPanelFor(null); return; }
    setAbPanelFor(slug); setAbPanel(null); setAbPanelBusy(true);
    try {
      const r = await fetch("/api/onebox/insights", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "page1Panel", slug }),
      });
      const j = await r.json();
      if (j.error) { setToast(j.error); setAbPanelFor(null); return; }
      setAbPanel(j);
      setAbDraft({ headline: j.proposal?.headline ?? "", congrats: j.proposal?.congrats ?? "" });
    } finally { setAbPanelBusy(false); }
  }, [abPanelFor]);
  const startAbTest = useCallback(async (slug: string) => {
    setAbPanelBusy(true);
    try {
      const r = await fetch("/api/onebox/insights", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "page1Start", slug, ...abDraft }),
      });
      const j = await r.json();
      if (j.error) { setToast(`Start failed: ${j.error}`); return; }
      setToast("A/B test is live — half her visitors now see the new page");
      setAbPanelFor(null);
      await Promise.all([loadStats(statsWin), loadInsights(), load()]);
    } finally { setAbPanelBusy(false); }
  }, [abDraft, loadStats, statsWin, loadInsights, load]);
  const endAbTest = useCallback(async (expId: number, keep: "a" | "b") => {
    if (!window.confirm(keep === "b"
      ? "Keep the NEW page? Her funnel switches to the winning copy and the test ends."
      : "Keep her CURRENT page? The test ends and nothing changes on the funnel.")) return;
    setAbPanelBusy(true);
    try {
      const r = await fetch("/api/onebox/insights", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "page1End", expId, keep }),
      });
      const j = await r.json();
      if (j.error) { setToast(`Ending failed: ${j.error}`); return; }
      setToast(keep === "b" ? "New page applied — test ended, traffic back to 100%" : "Test ended — current page kept");
      setAbPanelFor(null);
      await Promise.all([loadStats(statsWin), load()]);
    } finally { setAbPanelBusy(false); }
  }, [loadStats, statsWin, load]);
  const decideInsight = useCallback(async (id: number, decision: "approve" | "deny", reason?: string, suggestion?: string) => {
    setDecideBusy(id);
    try {
      const r = await fetch("/api/onebox/insights", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "decide", id, decision, reason, suggestion }),
      });
      const j = await r.json();
      if (j.error) { setToast(j.error); return; }
      // Approving records the decision — nothing runs by itself. Say so, or
      // the owner waits for a fix that is not coming (2026-09-12).
      setToast(decision === "approve" ? "Approved ✓ — noted as the plan. Nothing runs on its own: hand the fix to a coach, or ask Claude to do it." : "Denied — noted, I won't re-flag this for 3 weeks");
      setDenyFor(null); setDenyReason(""); setDenySuggestion("");
      await loadInsights();
    } finally { setDecideBusy(null); }
  }, [loadInsights]);

  /* Inline traffic editor. On a running test, saving weights is enough;
     on a paused one the weights only take effect once the test is resumed,
     so both happen in one click — and a resume the server refuses (the
     original URL redirecting back to us) surfaces its reason as the toast. */
  const [trafficFor, setTrafficFor] = useState<string | null>(null);
  const [trafficW, setTrafficW] = useState<Record<string, number>>({});
  const [trafficBusy, setTrafficBusy] = useState(false);
  const applyTraffic = useCallback(async (t: NonNullable<Funnel["traffic"]>, weights: Record<string, number>) => {
    setTrafficBusy(true);
    try {
      const r = await fetch("/api/onebox/ab", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "weights", id: t.expId, weights }),
      });
      if (!r.ok) { setToast("Saving traffic weights failed"); return; }
      if (t.status !== "running") {
        const r2 = await fetch("/api/onebox/ab", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "status", id: t.expId, status: "running" }),
        });
        const j2 = await r2.json().catch(() => ({} as { error?: string }));
        if (!r2.ok || j2.error) { setToast(j2.error ?? "Resuming the test failed"); return; }
      }
      setToast("Traffic updated — live immediately");
      setTrafficFor(null);
      await load();
    } finally { setTrafficBusy(false); }
  }, [load]);

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
      else setToast(action === "resync" ? `Synced from GHL ✓${j.photoNote ? ` · ${j.photoNote}` : ""}${j.surveyNote ? ` · ${j.surveyNote}` : ""}` : "Saved ✓");
      if (!j.error && (action === "cvs" || action === "extras")) {
        setSavedFlash(slug);
        window.setTimeout(() => setSavedFlash((cur) => (cur === slug ? null : cur)), 2500);
      }
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
  /* The SOP + verification live under Start Setup, while the start button
     sits under Split test — so a passed verification must SURVIVE closing
     one panel and opening the other. It resets only when the test mode
     flips or a Start Setup panel opens fresh (see the button handler). */
  useEffect(() => {
    setSop({ renamed: false, redirect: false, values: false, workflow: false });
    setStartVerify(null);
  }, [abMode]);

  async function verifyStart(slug: string) {
    const target = abOrigUrl.trim();
    setVerifySlug(slug);
    if (!target) { setToast("Add the original funnel URL first (under Start Setup)"); return; }
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

  async function verifyRedirect(slug: string) {
    const adUrl = adUrlForm.trim();
    if (!adUrl) { setToast("Paste the ad link first (the GHL funnel URL running in the ads)"); return; }
    setRedirectVerify({ loading: true });
    try {
      const r = await fetch("/api/onebox/admin", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verifyRedirect", slug, adUrl }),
      });
      const j = await r.json();
      setRedirectVerify(j.error ? { error: j.error } : j);
      if (j.ok) await load();
    } catch {
      setRedirectVerify({ error: "network error — try again" });
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
      // Success needs no prose — the new funnel card appears in the list below.
      setAddForm({ clientName: "", slug: "", locationId: "", oldFunnelUrl: "" });
      setSlugTouched(false);
      await load();
    } finally { setBusy(null); }
  }

  if (userLoading) return <div className="p-8 text-[#697a91]"><Loader2 className="w-5 h-5 animate-spin" /></div>;
  if (role !== "admin" && role !== "editor" && role !== "media_buyer") return <div className="p-8 text-[#697a91]">Admins, coaches and media buyers only.</div>;
  /* A Client Success Coach sees the client funnels only — no Optimizer, no
     agency B2B funnel, no add/edit controls (the API refuses them anyway). */
  const isAdmin = role === "admin";
  /* Client Success Coaches ("editor") onboard clients too: they get
     Add client + Start Setup (with Save to GHL); everything that moves
     traffic or money stays admin-only. */
  const canEdit = isAdmin || role === "editor";

  return (
    <div className="p-3 md:p-6 max-w-[1200px] mx-auto">
      {/* One line on a phone: compact title, buttons collapse to their icons. */}
      <div className="flex items-center justify-between gap-2 mb-3 flex-nowrap">
        <h1 className="text-base sm:text-lg font-semibold text-[#1c2b3a] truncate">🧪 One-Box Funnels</h1>
        <div className="flex gap-2 shrink-0">
          <button onClick={() => void load()} title="Refresh" className="flex items-center gap-1.5 text-sm border border-[#e4ebf2] rounded-lg px-2.5 sm:px-3 py-1.5 hover:bg-[#f6f9fc]">
            <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} /> <span className="hidden sm:inline">Refresh</span>
          </button>
          {canEdit && (
            <button onClick={() => setShowAdd((s) => !s)} title="Add client" className="flex items-center gap-1.5 text-sm bg-[#0e9c9c] text-white rounded-lg px-2.5 sm:px-3 py-1.5 hover:bg-[#0b8383]">
              <Plus className="w-4 h-4" /> <span className="hidden sm:inline">Add client</span>
            </button>
          )}
        </div>
      </div>

      <div className="relative mb-3">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#697a91]" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search a client…"
          className="w-full pl-9 pr-3 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm text-[#1c2b3a] focus:outline-none focus:border-[#15B7AE]" />
      </div>

      {toast && <div className="mb-3 text-sm bg-[#e7f6ec] border border-[#bfe3cd] text-[#15803d] rounded-lg px-3 py-2">{toast}</div>}

      {showAdd && (
        <div className="mb-4 border border-[#e4ebf2] rounded-xl p-4 bg-white">
          <div className="font-medium text-sm mb-3 text-[#1c2b3a]">Add a client funnel</div>
          <div className="grid md:grid-cols-2 gap-3">
            <input placeholder="Client / business name" value={addForm.clientName}
              onChange={(e) => setAddForm((f) => ({ ...f, clientName: e.target.value, slug: slugTouched && f.slug ? f.slug : slugify(e.target.value) }))}
              className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-sm" />
            <input placeholder="Slug (URL path, e.g. pmu-by-ivan)" value={addForm.slug}
              onChange={(e) => { setSlugTouched(e.target.value.trim().length > 0); setAddForm((f) => ({ ...f, slug: e.target.value })); }}
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
        </div>
      )}

      {loading ? (
        <div className="p-10 text-center text-[#697a91]"><Loader2 className="w-5 h-5 animate-spin inline" /></div>
      ) : funnels.length === 0 ? (
        <div className="p-10 text-center text-[#697a91] text-sm">No funnels yet — add the first client.</div>
      ) : (
        <div className="space-y-1.5">
          {funnels.some((f) => f.status === "live" && f.slug !== "demo-v3" && f.template !== "b2b") && (
            <div className="border border-[#bfe6e2] rounded-xl bg-white p-4">
              <button
                onClick={() => {
                  const open = !statsOpen;
                  setStatsOpen(open);
                  if (open && !stats) void loadStats(statsWin);
                }}
                className="w-full flex items-center gap-2 text-sm font-medium text-[#1c2b3a]">
                <span className="w-2 h-2 rounded-full bg-[#0e9c9c]" />
                One-box performance — all clients
                <span className="text-xs text-[#697a91]">
                  ({funnels.filter((f) => f.status === "live" && f.slug !== "demo-v3" && f.template !== "b2b").length} live)
                </span>
                <span className="ml-auto text-[#697a91]">{statsOpen ? "▲" : "▼"}</span>
              </button>
              {statsOpen && (
                <div className="mt-3">
                  <div className="flex items-center gap-1.5 mb-2">
                    {( [7, 14, 30, "since"] as const).map((w) => (
                      <button key={w}
                        onClick={() => { setStatsWin(w); void loadStats(w); }}
                        title={w === "since" ? "Only visits and leads after the database moved to the US (faster pages) — Sep 19, 2026. No ad spend for this window." : undefined}
                        className={cn("text-[11px] font-semibold rounded-md px-2.5 py-1 border",
                          statsWin === w ? "bg-[#0e9c9c] text-white border-[#0e9c9c]" : "border-[#e4ebf2] text-[#697a91] hover:bg-[#f6f9fc]")}>
                        {w === "since" ? "Since US switch (Sep 19)" : `Last ${w} days`}
                      </button>
                    ))}
                    {statsLoading && <Loader2 className="w-3.5 h-3.5 animate-spin text-[#697a91]" />}
                  </div>
                  {stats && (() => {
                    /* Fleet benchmark = the all-clients rate; a cell sitting
                       25%+ under it turns orange — that's the bottleneck to
                       fix. Only flagged when the client's traffic is enough
                       for the average to predict 3+ of the event: deposits
                       are rare, and 0 deposits on 60 visitors is expectation,
                       not a bottleneck — orange everywhere would say nothing. */
                    const t = stats.reduce((acc, s) => ({
                      vis: acc.vis + s.visitors, leads: acc.leads + s.leads, picked: acc.picked + s.picked,
                      dep: acc.dep + s.deposits, ai: acc.ai + s.aiDeposits, spend: acc.spend + (s.spend ?? 0),
                    }), { vis: 0, leads: 0, picked: 0, dep: 0, ai: 0, spend: 0 });
                    /* Lead rate is per VISITOR; pick and the two deposit
                       rates are per LEAD (of the people who filled the survey). */
                    const bench = {
                      lead: t.vis ? (t.leads / t.vis) * 100 : 0,
                      pick: t.leads ? (t.picked / t.leads) * 100 : 0,
                      dep: t.leads ? (t.dep / t.leads) * 100 : 0,
                      ai: t.leads ? (t.ai / t.leads) * 100 : 0,
                    };
                    const low = (base: number, rate: number | null, avg: number) =>
                      rate != null && avg > 0 && base * (avg / 100) >= 3 && rate < 0.75 * avg;
                    const rateCell = (base: number, rate: number | null, avg: number, extraCls = "") => (
                      <td className={cn("py-1.5 pr-3", extraCls,
                        low(base, rate, avg) && "bg-[#fff3e6] text-[#c2410c] font-semibold")}
                        title={rate == null ? "nothing in this window yet — rates need data"
                          : low(base, rate, avg) ? `25%+ below the all-clients average (${avg.toFixed(1)}%) — likely bottleneck` : undefined}>
                        {rate != null ? `${rate}%` : "—"}
                      </td>
                    );
                    const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
                    return (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead className="text-[#697a91]">
                          <tr className="text-left">
                            <th className="py-1 pr-3 font-medium">Client</th>
                            <th className="py-1 pr-3 font-medium">Visitors</th>
                            <th className="py-1 pr-3 font-medium">Leads</th>
                            <th className="py-1 pr-3 font-medium">Lead rate</th>
                            <th className="py-1 pr-3 font-medium">Picked time</th>
                            <th className="py-1 pr-3 font-medium">Pick rate</th>
                            <th className="py-1 pr-3 font-medium">Deposits</th>
                            <th className="py-1 pr-3 font-medium">Deposit rate</th>
                            <th className="py-1 pr-3 font-medium">AI deposits</th>
                            <th className="py-1 pr-3 font-medium">AI dep. rate</th>
                            <th className="py-1 pr-3 font-medium">Spend</th>
                            <th className="py-1 pr-3 font-medium">Cost / booking</th>
                          </tr>
                        </thead>
                        <tbody>
                          {stats.map((s) => (
                            <Fragment key={s.slug}>
                            <tr className="border-t border-[#eef2f6]">
                              <td className="py-1.5 pr-3 font-medium text-[#1c2b3a]">{s.clientName || s.slug}</td>
                              <td className="py-1.5 pr-3">{s.visitors}</td>
                              <td className="py-1.5 pr-3">{s.leads}</td>
                              <td className={cn("py-1.5 pr-3 whitespace-nowrap", low(s.visitors, s.leadRate, bench.lead) && "bg-[#fff3e6] text-[#c2410c] font-semibold")}
                                title={s.leadRate == null ? "nothing in this window yet — rates need data"
                                  : low(s.visitors, s.leadRate, bench.lead) ? `25%+ below the all-clients average (${bench.lead.toFixed(1)}%) — likely bottleneck` : undefined}>
                                {s.leadRate != null ? `${s.leadRate}%` : "—"}
                                {(low(s.visitors, s.leadRate, bench.lead) || page1Map[s.slug]) && (
                                  <button onClick={() => void openAbPanel(s.slug)}
                                    title={page1Map[s.slug] ? "An A/B test is running on her first page — click to see the live results" : "Test a better first page on this client: 50/50, only page 1 changes"}
                                    className={cn("ml-1.5 text-[10px] font-semibold rounded-md px-1.5 py-0.5 border align-middle",
                                      abPanelFor === s.slug ? "bg-[#7c3aed] text-white border-[#7c3aed]"
                                      : page1Map[s.slug] ? "bg-[#f3e8ff] text-[#7c3aed] border-[#d8b4fe] hover:bg-[#ead9fe]"
                                      : "bg-white text-[#7c3aed] border-[#d8b4fe] hover:bg-[#f3e8ff]")}>
                                    {page1Map[s.slug] ? "A/B test ⏳" : "Launch A/B test"}
                                  </button>
                                )}
                              </td>
                              <td className="py-1.5 pr-3">{s.picked}</td>
                              {rateCell(s.leads, pct(s.picked, s.leads), bench.pick)}
                              <td className="py-1.5 pr-3 font-semibold">{s.deposits}</td>
                              {rateCell(s.leads, pct(s.deposits, s.leads), bench.dep, "font-semibold")}
                              <td className="py-1.5 pr-3 text-[#7c3aed] font-medium">{s.aiDeposits}</td>
                              {rateCell(s.leads, pct(s.aiDeposits, s.leads), bench.ai, "text-[#7c3aed]")}
                              <td className="py-1.5 pr-3">{s.spend != null ? `$${s.spend}` : "—"}</td>
                              <td className="py-1.5 pr-3 font-semibold text-[#1c2b3a]">{s.costPerBooking != null ? `$${s.costPerBooking}` : "—"}</td>
                            </tr>
                            {abPanelFor === s.slug && (
                              <tr className="border-t border-[#eee]">
                                <td colSpan={12} className="py-2">
                                  <div className="border border-[#d8b4fe] rounded-lg bg-[#fdfbff] p-3 grid gap-2 text-xs">
                                    {abPanelBusy && !abPanel ? (
                                      <span className="text-[#697a91]"><Loader2 className="w-3.5 h-3.5 animate-spin inline" /> Loading…</span>
                                    ) : abPanel?.test ? (
                                      <>
                                        <b className="text-[#1c2b3a]">A/B test running since {new Date(abPanel.test.startedAt).toLocaleDateString()} — first page only, 50/50</b>
                                        <div className="grid sm:grid-cols-2 gap-2">
                                          <div className="border border-[#e4ebf2] rounded-lg bg-white p-2">
                                            <b>Current page</b>
                                            <a href={`https://book.pmu-care.com/s/${s.slug}?ob_v=a`} target="_blank" rel="noreferrer" className="ml-2 text-[10px] text-[#0e9c9c] hover:underline">view ↗</a>
                                            <div className="text-[#697a91] mt-0.5">{abPanel.test.visA} visitors · {abPanel.test.leadsA} leads · <b className="text-[#1c2b3a]">{abPanel.test.rateA ?? "—"}%</b> lead rate</div>
                                          </div>
                                          <div className="border border-[#d8b4fe] rounded-lg bg-white p-2">
                                            <b className="text-[#7c3aed]">New page</b>
                                            <a href={`https://book.pmu-care.com/s/${s.slug}?ob_v=b`} target="_blank" rel="noreferrer" className="ml-2 text-[10px] text-[#7c3aed] hover:underline">view ↗</a>
                                            <div className="text-[#697a91] mt-0.5">{abPanel.test.visB} visitors · {abPanel.test.leadsB} leads · <b className="text-[#1c2b3a]">{abPanel.test.rateB ?? "—"}%</b> lead rate</div>
                                            <div className="text-[10px] text-[#697a91] mt-1 italic">&ldquo;{abPanel.test.override.headline ?? ""}&rdquo;</div>
                                          </div>
                                        </div>
                                        <span className="text-[10px] text-[#697a91]">
                                          A verdict is solid from ~400 visitors per side (now {abPanel.test.visA} / {abPanel.test.visB}). End it whenever you&rsquo;re convinced:
                                        </span>
                                        <div className="flex flex-wrap gap-2">
                                          <button onClick={() => void endAbTest(abPanel.test!.expId, "b")} disabled={abPanelBusy}
                                            className="text-xs bg-[#0e9c9c] text-white rounded-md px-3 py-1 hover:bg-[#0b8383] disabled:opacity-50">
                                            Keep NEW page — end test
                                          </button>
                                          <button onClick={() => void endAbTest(abPanel.test!.expId, "a")} disabled={abPanelBusy}
                                            className="text-xs border border-[#e4ebf2] rounded-md px-3 py-1 hover:bg-white disabled:opacity-50">
                                            Keep CURRENT page — end test
                                          </button>
                                        </div>
                                      </>
                                    ) : abPanel ? (
                                      <>
                                        <b className="text-[#1c2b3a]">Test a better first page — edit the copy if you like, then start. Only page 1 changes; half her visitors see it.</b>
                                        <label className="grid gap-0.5">
                                          <span className="text-[10px] text-[#697a91]">Headline — now: <i>{abPanel.current.headline || "Fill Out Our Quiz To See If You Qualify (standard)"}</i></span>
                                          <input value={abDraft.headline} onChange={(e) => setAbDraft((x) => ({ ...x, headline: e.target.value }))}
                                            className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-xs" />
                                        </label>
                                        <label className="grid gap-0.5">
                                          <span className="text-[10px] text-[#697a91]">Offer line — now: <i>{abPanel.current.congrats || "Congrats on claiming [offer] All Permanent Makeup Packages! (standard)"}</i></span>
                                          <input value={abDraft.congrats} onChange={(e) => setAbDraft((x) => ({ ...x, congrats: e.target.value }))}
                                            className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-xs" />
                                        </label>
                                        <div>
                                          <button onClick={() => void startAbTest(s.slug)} disabled={abPanelBusy}
                                            className="text-xs bg-[#7c3aed] text-white rounded-md px-3 py-1.5 hover:bg-[#6d28d9] disabled:opacity-50 inline-flex items-center gap-1.5">
                                            {abPanelBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : null} Approve — start the A/B test (50/50)
                                          </button>
                                        </div>
                                      </>
                                    ) : null}
                                  </div>
                                </td>
                              </tr>
                            )}
                            </Fragment>
                          ))}
                          <tr className="border-t-2 border-[#bfe6e2] bg-[#f7fdfc] font-semibold text-[#1c2b3a]">
                            <td className="py-1.5 pr-3">All clients</td>
                            <td className="py-1.5 pr-3">{t.vis}</td>
                            <td className="py-1.5 pr-3">{t.leads}</td>
                            <td className="py-1.5 pr-3">{t.vis ? `${bench.lead.toFixed(1)}%` : "—"}</td>
                            <td className="py-1.5 pr-3">{t.picked}</td>
                            <td className="py-1.5 pr-3">{t.leads ? `${bench.pick.toFixed(1)}%` : "—"}</td>
                            <td className="py-1.5 pr-3">{t.dep}</td>
                            <td className="py-1.5 pr-3">{t.leads ? `${bench.dep.toFixed(1)}%` : "—"}</td>
                            <td className="py-1.5 pr-3 text-[#7c3aed]">{t.ai}</td>
                            <td className="py-1.5 pr-3 text-[#7c3aed]">{t.leads ? `${bench.ai.toFixed(1)}%` : "—"}</td>
                            <td className="py-1.5 pr-3">{t.spend ? `$${t.spend.toFixed(2)}` : "—"}</td>
                            <td className="py-1.5 pr-3">{t.spend && t.picked ? `$${(t.spend / t.picked).toFixed(2)}` : "—"}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    );
                  })()}
                  <p className="mt-2 text-[10px] text-[#697a91]">
                    Funnel-wide numbers for every live one-box client (all traffic is one-box now).
                    Same counting rules as the old split tables: unique clients within 21 days, deposits =
                    paid on the funnel, AI deposits = collected by text afterwards. Lead rate is per visitor; Pick rate,
                    Deposit rate and AI dep. rate are per LEAD — of the people who filled the survey,
                    the share who picked a time / paid. <span className="bg-[#fff3e6] text-[#c2410c] font-semibold px-1 rounded">Orange</span> =
                    25%+ below the all-clients average — the likely bottleneck to look at. A cell only
                    qualifies once the client has enough traffic for the average to predict 3+ of that
                    event, so rare things (deposits) on small traffic don&rsquo;t cry wolf. Spend matches the ad account by the pinned owner name in
                    Extras (or the client name).
                  </p>
                </div>
              )}
            </div>
          )}
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
                />
              )}
            </div>
          )}
          {/* B2C on top; everything B2B sinks to the very bottom behind its
              own divider — the 99% of attention goes to the client funnels. */}
          {visibleFunnels.length === 0 && (
            <div className="p-6 text-center text-[#697a91] text-sm">No funnel matches “{search}”.</div>
          )}
          {visibleFunnels
            .map((f, i, arr) => (
            <Fragment key={f.slug}>
            {f.template !== "b2b" && (i === 0 || programSection(arr[i - 1]) !== programSection(f)) && (
              <div className={cn("flex items-center gap-3", i === 0 ? "pt-1" : "pt-3")}>
                <div className={cn("h-px flex-1", programSection(f) === "V3 CLIENTS" ? "bg-[#bfe6e2]" : "bg-[#e4ebf2]")} />
                <span className={cn("text-[11px] font-semibold tracking-wide",
                  programSection(f) === "V3 CLIENTS" ? "text-[#0b7f7f]"
                  : programSection(f) === "V1 CLIENTS" ? "text-[#c2410c]" : "text-[#697a91]")}>
                  {programSection(f)} ({arr.filter((x) => programSection(x) === programSection(f)).length})
                </span>
                <div className={cn("h-px flex-1", programSection(f) === "V3 CLIENTS" ? "bg-[#bfe6e2]" : "bg-[#e4ebf2]")} />
              </div>
            )}
            {f.template === "b2b" && (i === 0 || arr[i - 1].template !== "b2b") && (
              <>
                <div className="flex items-center gap-3 pt-8">
                  <div className="h-px flex-1 bg-[#9fd8d4]" />
                  <span className="text-[11px] font-semibold tracking-wide text-[#0b7f7f]">B2B — AGENCY FUNNEL</span>
                  <div className="h-px flex-1 bg-[#9fd8d4]" />
                </div>
                {funnels.some((x) => x.abStatus === "running" && x.template === "b2b") && (
                  <div className="border border-[#9fd8d4] rounded-xl bg-white p-4">
                    <button
                      onClick={() => {
                        const open = !b2bOverviewOpen;
                        setB2bOverviewOpen(open);
                        if (open) funnels.filter((x) => x.abStatus === "running" && x.template === "b2b").forEach((x) => void loadAb(x.slug));
                      }}
                      className="w-full flex items-center gap-2 text-sm font-medium text-[#1c2b3a]">
                      <span className="w-2 h-2 rounded-full bg-[#0e9c9c] animate-pulse" />
                      B2B split test — agency funnel
                      <span className="text-xs text-[#697a91]">
                        ({funnels.filter((x) => x.abStatus === "running" && x.template === "b2b").length} running)
                      </span>
                      <span className="ml-auto text-[#697a91]">{b2bOverviewOpen ? "▲" : "▼"}</span>
                    </button>
                    {b2bOverviewOpen && (
                      <SplitOverviewTable
                        rows={funnels.filter((x) => x.abStatus === "running" && x.template === "b2b")}
                        ab={ab}
                        showTotals={false}
                        footnote="The agency's own B2B funnel (PMU Bookings On Demand) — the win here is a booked strategy call, so read Visitors → Leads → Picked time and ignore the deposit columns. Kept out of the client totals above because it's a different business."
                      />
                    )}
                  </div>
                )}
              </>
            )}
            <div className="border border-[#e4ebf2] rounded-xl bg-white px-4 py-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-[#1c2b3a]">{f.clientName || f.slug}</span>
                    <span className={cn("text-[11px] font-semibold rounded-full px-2 py-0.5 border",
                      f.status === "live" ? "bg-[#e7f6ec] text-[#15803d] border-[#bfe3cd]" : "bg-[#fff3e6] text-[#c2410c] border-[#fdba74]")}>
                      {f.status.toUpperCase()}
                    </span>
                    {f.template !== "b2b" && f.slug !== "demo-v3" && (f.program ? (
                      <button
                        title={`Program from the Clients Master sheet (row ${f.program.sheetRow}, ${f.program.ownerName})` +
                          (f.program.matches > 1 ? ` — ⚠ ${f.program.matches} sheet rows matched this business name, using the newest` : "") +
                          (f.program.via === "prefix" ? " — matched by name prefix" : "") +
                          " — click to change (updates the Clients tab + sheet)"}
                        onClick={() => setProgFor(progFor === f.slug ? null : f.slug)}
                        className={cn("text-[11px] font-semibold rounded-full px-2 py-0.5 border",
                          f.program.version === "(V3)" ? "bg-[#e7f6f6] text-[#0b7f7f] border-[#bfe6e2] hover:bg-[#d8f0ef]"
                          : f.program.version === "(V1)" ? "bg-[#fff3e6] text-[#c2410c] border-[#fdba74] hover:bg-[#ffe9d1]"
                          : "bg-[#f6f9fc] text-[#697a91] border-[#e4ebf2] hover:bg-[#eef3f8]")}>
                        {f.program.version.replace(/[()]/g, "") || "no version"}{f.program.matches > 1 ? " ⚠" : ""}
                      </button>
                    ) : (
                      <span
                        title="No row on the Clients Master sheet matches this business name — fix the name there (or in this funnel's client name) and the program will sync"
                        className="text-[11px] rounded-full px-2 py-0.5 border bg-[#fef2f2] text-[#b91c1c] border-[#fecaca]">
                        not on Clients sheet
                      </span>
                    ))}
                    {f.abStatus === "running" && (
                      <button title="Split test is live — click for details"
                        onClick={() => { if (abFor !== f.slug) { setAbFor(f.slug); if (!abOrigUrl) setAbOrigUrl(f.oldFunnelUrl || ""); void loadAb(f.slug); } }}
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
                    <button
                      title={f.traffic?.status === "running"
                        ? "Where this funnel's ad traffic goes right now — click to change"
                        : "No test running — the splitter sends every visitor to the one-box funnel. Click to manage."}
                      onClick={() => {
                        if (trafficFor === f.slug) { setTrafficFor(null); return; }
                        setTrafficFor(f.slug);
                        if (f.traffic) {
                          /* Prefill with the truth: live weights on a running
                             test; 0/100 toward one-box on a paused one. */
                          setTrafficW(Object.fromEntries(f.traffic.variants.map((v) =>
                            [v.vkey, f.traffic!.status === "running" ? v.weight : (v.kind === "external" ? 0 : 100)])));
                        }
                      }}
                      className={cn("text-[11px] font-semibold rounded-full px-2 py-0.5 border inline-flex items-center gap-1",
                        trafficFor === f.slug ? "bg-[#0e9c9c] text-white border-[#0e9c9c]" : "bg-[#f0fbfa] text-[#0b7f7f] border-[#bfe6e2] hover:bg-[#e2f6f4]")}>
                      🚦 {trafficSummary(f.traffic)}
                    </button>
                    <a href={f.url} target="_blank" rel="noopener" className="text-xs text-[#0e9c9c] hover:underline inline-flex items-center gap-1">
                      {f.url} <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                  {f.oldFunnelUrl && (
                    <div className="text-[11px] text-[#697a91]">
                      redirect: <a href={f.oldFunnelUrl} target="_blank" rel="noopener" className="hover:underline">{f.oldFunnelUrl}</a>
                      {" → "}
                      <span className="text-[#0e9c9c]">{f.url}</span>
                      {f.redirectVerifiedAt && <span className="text-[#15803d]"> ✓ verified {ago(f.redirectVerifiedAt)}</span>}
                    </div>
                  )}
                </div>
                <div className="flex-1" />
                <div className="text-right text-xs text-[#697a91] whitespace-nowrap">
                  <b className="text-[#1c2b3a] text-sm">{f.visitors}</b> visitors ·{" "}
                  <button className="hover:underline" onClick={() => { setLeadsFor(leadsFor === f.slug ? null : f.slug); setLeadFilter("all"); void loadLeads(f.slug); }}>
                    <b className="text-[#0e9c9c] text-sm">{f.leads}</b> leads
                  </button>
                  {" · "}
                  <button className="hover:underline" onClick={() => { setLeadsFor(f.slug); setLeadFilter("picked_no_deposit"); void loadLeads(f.slug); }}>
                    <b className="text-[#0e9c9c] text-sm">{f.booked}</b> picked
                  </button>
                  {" · "}
                  <button className="hover:underline" onClick={() => { setLeadsFor(f.slug); setLeadFilter("deposits"); void loadLeads(f.slug); }}>
                    <b className="text-[#0e9c9c] text-sm">{f.paid}</b> deposits
                  </button>
                  <span className="text-[10px] text-[#97a5b8]" title={`last lead ${ago(f.lastLeadAt)} · synced ${ago(f.cvSyncedAt)}`}>
                    {" "}· lead {ago(f.lastLeadAt)}
                  </span>
                </div>
              </div>

              {progFor === f.slug && f.program && (
                <div className="mt-2 border border-[#e4ebf2] rounded-lg bg-[#f6f9fc] p-2.5 flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-[#425466]">
                    Program for <b>{f.program.ownerName || f.clientName}</b> — one click changes it here, on the Clients tab, and on the Clients Master sheet together:
                  </span>
                  {/* Only V3 and V1 are offered (user, 2026-09-14 / 16); a client
                      still on an older version just has neither chip selected. */}
                  {["(V3)", "(V1)"].map((v) => (
                    <button key={v} onClick={() => void saveProgram(f, v)} disabled={progBusy === f.slug}
                      className={cn("text-[11px] font-semibold border rounded-md px-2.5 py-1 disabled:opacity-50",
                        f.program!.version === v ? "bg-[#0e9c9c] text-white border-[#0e9c9c]" : "border-[#e4ebf2] bg-white hover:bg-[#eef6f6]")}>
                      {progBusy === f.slug ? <Loader2 className="w-3 h-3 animate-spin inline" /> : v}
                    </button>
                  ))}
                </div>
              )}

              {trafficFor === f.slug && (f.traffic ? (
                <div className="mt-2 border border-[#bfe6e2] rounded-lg bg-[#f7fdfc] p-2.5">
                  {f.traffic.status === "paused" && (
                    <div className="text-[11px] text-[#697a91] mb-2">
                      No test is running — the splitter sends <b className="text-[#1c2b3a]">every visitor to the one-box funnel</b>.
                      To send some back to the original
                      {(() => {
                        const ext = f.traffic!.variants.find((v) => v.kind === "external" && v.target);
                        return ext?.target ? (
                          <> (<a href={ext.target} target="_blank" rel="noopener" className="text-[#0e9c9c] hover:underline break-all">{ext.target.replace(/^https?:\/\//, "")}</a>)</>
                        ) : null;
                      })()}
                      , set the weights and apply.
                      <span className="text-[#c2410c]"> ⚠ Apple Pay / Cash App are still broken on original GHL funnels.</span>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    {f.traffic.variants.map((v) => (
                      <label key={v.vkey} className="inline-flex items-center gap-1.5 text-xs text-[#1c2b3a]">
                        <span className="font-medium">{v.label}</span>
                        <span className="text-[10px] text-[#697a91]">({v.kind === "external" ? "GHL" : "one-box"})</span>
                        <input type="number" min={0} max={100} value={trafficW[v.vkey] ?? 0}
                          onChange={(e) => setTrafficW((w) => ({ ...w, [v.vkey]: Math.max(0, Math.min(100, Number(e.target.value) || 0)) }))}
                          className="w-14 border border-[#e4ebf2] rounded-md px-1.5 py-0.5 text-xs text-right" />%
                      </label>
                    ))}
                    <div className="flex-1" />
                    {f.traffic.variants.length === 2 && (
                      <>
                        <button onClick={() => setTrafficW({ [f.traffic!.variants[0].vkey]: 0, [f.traffic!.variants[1].vkey]: 100 })}
                          className="text-[11px] border border-[#e4ebf2] rounded-md px-2 py-0.5 hover:bg-white">100% {f.traffic.variants[1].label}</button>
                        <button onClick={() => setTrafficW({ [f.traffic!.variants[0].vkey]: 50, [f.traffic!.variants[1].vkey]: 50 })}
                          className="text-[11px] border border-[#e4ebf2] rounded-md px-2 py-0.5 hover:bg-white">50 / 50</button>
                        <button onClick={() => setTrafficW({ [f.traffic!.variants[0].vkey]: 100, [f.traffic!.variants[1].vkey]: 0 })}
                          className="text-[11px] border border-[#e4ebf2] rounded-md px-2 py-0.5 hover:bg-white">100% {f.traffic.variants[0].label}</button>
                      </>
                    )}
                    {(() => {
                      /* Resuming a paused test only means something if the
                         original actually gets a share — otherwise there is
                         nothing to change, so don't fake a running test. */
                      const extShare = f.traffic!.variants.filter((v) => v.kind === "external")
                        .reduce((s, v) => s + (trafficW[v.vkey] ?? 0), 0);
                      const noopResume = f.traffic!.status === "paused" && extShare === 0;
                      return (
                        <button onClick={() => void applyTraffic(f.traffic!, trafficW)} disabled={trafficBusy || noopResume}
                          title={noopResume ? "Everything already goes to the one-box — give the original a % first" : undefined}
                          className="text-xs bg-[#0e9c9c] text-white rounded-md px-3 py-1 hover:bg-[#0b8383] disabled:opacity-50 inline-flex items-center gap-1">
                          {trafficBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                          {f.traffic!.status === "running" ? "Save — live immediately" : "Apply — resumes the test"}
                        </button>
                      );
                    })()}
                  </div>
                </div>
              ) : (
                <div className="mt-2 border border-[#bfe6e2] rounded-lg bg-[#f7fdfc] p-2.5 flex flex-wrap items-center gap-2 text-xs text-[#1c2b3a]">
                  <span>
                    <b>Every visitor goes to the one-box funnel</b> — this client has never had a split test,
                    so the splitter forwards all traffic straight through. To send any share to the original GHL funnel, set one up first.
                  </span>
                  {isAdmin && (
                  <button
                    onClick={() => { setTrafficFor(null); setAbFor(f.slug); if (!abOrigUrl) setAbOrigUrl(f.oldFunnelUrl || ""); void loadAb(f.slug); }}
                    className="border border-[#e4ebf2] rounded-md px-2.5 py-1 hover:bg-white text-[11px] font-medium">
                    Set up a test vs the original…
                  </button>
                  )}
                </div>
              ))}

              <div className="mt-1 flex flex-wrap items-center gap-1">
                <Dot ok={f.hasCalendar} label="calendar" />
                {/* V1 = no deposit, so no Commas product is expected; don't show a red ✗ for it. */}
                {!/v1/i.test(f.program?.version ?? "") && <Dot ok={f.hasFanbasis} label="commas" />}
                <Dot ok={f.hasWidget} label="results widget" />
                <Dot ok={f.hasPixel} label="pixel" />
                <div className="flex-1" />
                {isAdmin && (<>
                <button onClick={() => void act("resync", f.slug)} disabled={busy === `resync:${f.slug}`}
                  className="text-[11px] border border-[#e4ebf2] rounded-lg px-2 py-0.5 hover:bg-[#f6f9fc] inline-flex items-center gap-1">
                  {busy === `resync:${f.slug}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Sync Custom Values From GHL
                </button>
                </>)}
                {canEdit && (
                <button onClick={() => {
                    const open = cvFor === f.slug;
                    setCvFor(open ? null : f.slug);
                    if (!open) {
                      setCvForm({ ...f.cv });
                      setExtrasForm({ fanbasisHtml: "", elfsightId: "", resultImgs: "", metaPixelId: "", oldFunnelUrl: "", ownerName: "" }); setPixelOther(false);
                      setSurveyRows(parseSurvey((f.cv.surveyRaw ?? "").trim() || DEFAULT_SURVEY_TEMPLATE));
                      setSurveyDirty(false);
                      setAbOrigUrl(f.oldFunnelUrl ? f.oldFunnelUrl.replace(/\/?$/, "") + "-ab-ghl" : "");
                      setSop({ renamed: false, redirect: false, values: false, workflow: false });
                      setStartVerify(null);
                      setRedirectChoice(f.adRedirect);
                      setAdUrlForm(f.oldFunnelUrl || "");
                      setRedirectVerify(null);
                      setSop5({ renamed: false, redirect: false, workflow: false });
                      setFullForm(false);
                    }
                  }}
                  className={cn("text-[11px] border rounded-lg px-2 py-0.5",
                    cvFor === f.slug ? "bg-[#0e9c9c] text-white border-[#0e9c9c] hover:bg-[#0b8383]" : "border-[#e4ebf2] hover:bg-[#f6f9fc]")}>
                  Start Setup {cvFor === f.slug ? "▲" : ""}
                </button>
                )}
                {/* Coaches publish their own onboardings — Go live is not admin-gated. */}
                {canEdit && (
                <button onClick={() => void act("status", f.slug, { status: f.status === "live" ? "paused" : "live" })}
                  disabled={busy === `status:${f.slug}`}
                  className={cn("text-xs rounded-lg px-2.5 py-1 border font-medium",
                    f.status === "live" ? "border-[#fdba74] text-[#c2410c] hover:bg-[#fff3e6]" : "ob-golive border-[#bfe3cd] text-[#15803d] bg-[#e7f6ec] hover:bg-[#d6f0df]")}>
                  {f.status === "live" ? "Pause" : "Go live"}
                </button>
                )}
              </div>

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
                  <p className="text-[11px] font-bold text-[#0b7f7f]">Step 1 &middot; Business details</p>
                  <div className="grid md:grid-cols-2 gap-2">
                    {([
                      ["biz", "Business name"],
                      ["phone", "Business phone"],
                      ["address", "Full address"],
                      ["offer", "Offer (e.g. $200 OFF All Packages)"],
                      ["deposit", "Deposit amount (e.g. $50)"],
                      ["calendarId", "Calendar ID"],
                      ["fanbasisProductId", "Commas product ID"],
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
                    <label className="grid gap-0.5">
                      <span className="text-[10px] font-medium text-[#697a91]">Meta pixel ID{f.hasPixel ? "" : " (not set)"}</span>
                      {/* Every pixel already in use across the funnels, so a new
                          client is dropped onto the right shared pixel instead
                          of a typo (user, 2026-09-14). "Other…" opens a box. */}
                      <select value={pixelChoice(extrasForm.metaPixelId, f.pixelId ?? "")}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === "__other") { setPixelOther(true); setExtrasForm((x) => ({ ...x, metaPixelId: "" })); }
                          else { setPixelOther(false); setExtrasForm((x) => ({ ...x, metaPixelId: v === "__keep" ? "" : v })); }
                        }}
                        className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-xs bg-white">
                        <option value="__keep">{f.pixelId ? `Keep current — ${pixelLabel(f.pixelId)}` : "— pick a pixel —"}</option>
                        {pixelOptions.filter((o) => o.id !== f.pixelId).map((o) => (
                          <option key={o.id} value={o.id}>{o.label}</option>
                        ))}
                        <option value="__other">Other…</option>
                      </select>
                      {pixelOther && (
                        <input value={extrasForm.metaPixelId} placeholder="paste the pixel ID" autoFocus
                          onChange={(e) => setExtrasForm((x) => ({ ...x, metaPixelId: e.target.value.replace(/\D/g, "") }))}
                          className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-xs mt-1" />
                      )}
                    </label>
                  </div>
                  <button type="button" onClick={() => setFullForm((v) => !v)}
                    className="justify-self-start text-[11px] font-semibold text-[#0b7f7f] hover:underline">
                    {fullForm ? "▾" : "▸"} New client? Fill the full setup form (owner, links, V3 details, prices, photos)
                  </button>
                  {fullForm && (() => {
                    const T = (k: string, label: string, ph = "") => (
                      <label key={k} className="grid gap-0.5">
                        <span className="text-[10px] font-medium text-[#697a91]">{label}</span>
                        <input value={cvForm[k] ?? ""} placeholder={ph}
                          onChange={(e) => setCvForm((x) => ({ ...x, [k]: e.target.value }))}
                          className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-xs" />
                      </label>
                    );
                    const P = (k: string, label: string) => (
                      <label key={k} className="grid gap-0.5">
                        <span className="text-[10px] font-medium text-[#697a91]">{label}</span>
                        <ImageField value={cvForm[k] ?? ""} onChange={(u) => setCvForm((x) => ({ ...x, [k]: u }))} onToast={setToast} />
                      </label>
                    );
                    const H = (t: string) => <p className="text-[10px] font-bold text-[#697a91] uppercase tracking-wide mt-1 md:col-span-2">{t}</p>;
                    const picked = new Set((cvForm.services ?? "").split(",").map((x) => x.trim()).filter(Boolean));
                    const oneboxUrl = f.url;
                    return (
                      <div className="border border-[#bfe6e2] rounded-xl p-3 bg-[#f7fdfc] grid md:grid-cols-2 gap-2">
                        {H("Owner & links")}
                        {T("ownerName", "Owner's name (V3)")}
                        {T("igLink", "Instagram page link", "https://www.instagram.com/…")}
                        {T("fbLink", "Facebook page link", "https://www.facebook.com/…")}
                        {T("gmbLink", "Google My Business link", "https://g.page/r/… or maps link")}
                        {H("Prices (V3)")}
                        {T("originalPrice", "Original price for brows", "$597")}
                        {T("discountedPrice", "Discounted price for brows", "$397")}
                        {T("touchupPrice", "Touch-up price", "$150")}
                        {H("V3 details")}
                        <label className="grid gap-0.5 md:col-span-2">
                          <span className="text-[10px] font-medium text-[#697a91]">Permanent makeup services (tick all that apply)</span>
                          <div className="flex flex-wrap gap-1.5">
                            {[...SERVICE_OPTIONS, ...[...picked].filter((x) => !SERVICE_OPTIONS.includes(x))].map((opt) => (
                              <button key={opt} type="button"
                                onClick={() => {
                                  const next = new Set(picked);
                                  if (next.has(opt)) next.delete(opt); else next.add(opt);
                                  setCvForm((x) => ({ ...x, services: [...next].join(", ") }));
                                }}
                                className={cn("text-[11px] rounded-full px-2.5 py-1 border",
                                  picked.has(opt) ? "bg-[#0e9c9c] text-white border-[#0e9c9c]" : "bg-white border-[#e4ebf2] text-[#475569] hover:bg-[#f6f9fc]")}>
                                {opt}
                              </button>
                            ))}
                          </div>
                        </label>
                        {T("yearsInBusiness", "Years in business", "5")}
                        {T("businessHours", "Business hours", "Mon–Fri 9 AM–6 PM, Sat 10 AM–3 PM")}
                        {T("firstTouchup", "When is the first touch-up?", "6–8 weeks after the first session")}
                        {T("otherLocations", "Other locations", "none")}
                        <label className="grid gap-0.5 md:col-span-2">
                          <span className="text-[10px] font-medium text-[#697a91]">Extra notes for the AI (V3)</span>
                          <textarea value={cvForm.extraNotes ?? ""} rows={2}
                            onChange={(e) => setCvForm((x) => ({ ...x, extraNotes: e.target.value }))}
                            className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-xs" />
                        </label>
                        <label className="grid gap-0.5 md:col-span-2">
                          <span className="text-[10px] font-medium text-[#697a91]">Deposit funnel URL (the AI&rsquo;s pay link — normally this funnel)</span>
                          <div className="flex gap-1.5">
                            <input value={cvForm.depositFunnelUrl ?? ""} placeholder={oneboxUrl}
                              onChange={(e) => setCvForm((x) => ({ ...x, depositFunnelUrl: e.target.value }))}
                              className="flex-1 min-w-0 border border-[#e4ebf2] rounded-lg px-3 py-2 text-xs" />
                            {(cvForm.depositFunnelUrl ?? "") !== oneboxUrl && (
                              <button type="button" onClick={() => setCvForm((x) => ({ ...x, depositFunnelUrl: oneboxUrl }))}
                                className="shrink-0 text-[11px] border border-[#bfe6e2] text-[#0b7f7f] rounded-lg px-2.5 hover:bg-white">Use this funnel</button>
                            )}
                          </div>
                        </label>
                        {H("Photos")}
                        {P("logo", "Funnel logo")}
                        <div className="hidden md:block" />
                        {P("studio1", "Studio picture 1")}
                        {P("studio2", "Studio picture 2")}
                        {P("studio3", "Studio picture 3")}
                        <div className="hidden md:block" />
                        {P("brows1", "Eyebrows before & after 1")}
                        {P("brows2", "Eyebrows before & after 2")}
                        {P("brows3", "Eyebrows before & after 3")}
                        <div className="hidden md:block" />
                        {P("lips1", "Lips before & after 1")}
                        {P("lips2", "Lips before & after 2")}
                        {P("lips3", "Lips before & after 3")}
                        <div className="hidden md:block" />
                        {P("liner1", "Eyeliner before & after 1")}
                        {P("liner2", "Eyeliner before & after 2")}
                        {P("liner3", "Eyeliner before & after 3")}
                        <p className="text-[10px] text-[#697a91] md:col-span-2">Everything here is saved by <b>Step 3 &middot; Save to GoHighLevel</b> — straight into the sub-account&rsquo;s custom values, exactly what the old GHL form did.</p>
                      </div>
                    );
                  })()}
                  <div className="grid gap-1">
                    <p className="text-[11px] font-bold text-[#0b7f7f] mt-1">Step 2 &middot; Survey questions</p>
                    {surveyRows.map((row, i) => (
                      <div key={i} draggable
                        onDragStart={() => { surveyDragIdx.current = i; }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => {
                          const from = surveyDragIdx.current;
                          surveyDragIdx.current = null;
                          if (from == null || from === i) return;
                          setSurveyRows((rs) => { const c = [...rs]; const [m] = c.splice(from, 1); c.splice(i, 0, m); return c; });
                          setSurveyDirty(true);
                        }}
                        className={cn("flex items-center gap-1.5 border rounded-lg px-2 py-1 bg-white",
                          row.off ? "border-[#e4ebf2] opacity-60" : "border-[#cdeeed]")}>
                        <span className="cursor-grab text-[#97a5b8] select-none" title="Drag to reorder">&#8801;</span>
                        <button type="button"
                          title={row.off ? "Hidden from the survey — click to turn it back on" : "Live on the survey — click to hide it"}
                          onClick={() => { setSurveyRows((rs) => rs.map((r, j) => (j === i ? { ...r, off: !r.off } : r))); setSurveyDirty(true); }}
                          className={cn("text-[10px] font-semibold rounded-full px-2 py-0.5 border shrink-0 w-10",
                            row.off ? "bg-[#f6f9fc] text-[#697a91] border-[#e4ebf2]" : "bg-[#e7f6ec] text-[#15803d] border-[#bfe3cd]")}>
                          {row.off ? "OFF" : "ON"}
                        </button>
                        <input value={row.text} placeholder="Question text?"
                          onChange={(e) => { setSurveyRows((rs) => rs.map((r, j) => (j === i ? { ...r, text: e.target.value } : r))); setSurveyDirty(true); }}
                          className="flex-1 min-w-0 text-xs py-1 focus:outline-none" />
                        <input value={row.opts} placeholder="Option 1; Option 2"
                          onChange={(e) => { setSurveyRows((rs) => rs.map((r, j) => (j === i ? { ...r, opts: e.target.value } : r))); setSurveyDirty(true); }}
                          className="flex-1 min-w-0 text-xs py-1 text-[#697a91] focus:outline-none" />
                        <button type="button" disabled={i === 0} title="Move up"
                          onClick={() => { setSurveyRows((rs) => { const c = [...rs]; [c[i - 1], c[i]] = [c[i], c[i - 1]]; return c; }); setSurveyDirty(true); }}
                          className="text-[10px] text-[#697a91] hover:text-[#1c2b3a] disabled:opacity-20">&#9650;</button>
                        <button type="button" disabled={i === surveyRows.length - 1} title="Move down"
                          onClick={() => { setSurveyRows((rs) => { const c = [...rs]; [c[i], c[i + 1]] = [c[i + 1], c[i]]; return c; }); setSurveyDirty(true); }}
                          className="text-[10px] text-[#697a91] hover:text-[#1c2b3a] disabled:opacity-20">&#9660;</button>
                      </div>
                    ))}
                    {["Full Name", "Phone Number", "Email Address"].map((t) => (
                      <div key={t} className="flex items-center gap-1.5 border border-dashed border-[#e4ebf2] rounded-lg px-2 py-1 text-xs text-[#97a5b8]">
                        <span>&#128274;</span><span>{t}</span><span className="ml-auto text-[10px]">always last</span>
                      </div>
                    ))}
                    <button type="button"
                      onClick={() => { setSurveyRows((rs) => [...rs, { text: "", opts: "", off: false }]); setSurveyDirty(true); }}
                      className="justify-self-start text-[11px] font-medium text-[#0b7f7f] hover:underline">
                      + Add another question
                    </button>
                  </div>

                  <div className="border-t border-[#eef2f6] pt-3 grid gap-1 justify-items-start">
                    <p className="text-[11px] font-bold text-[#0b7f7f]">Step 3 &middot; Save to GoHighLevel</p>
                    <button
                      onClick={() => {
                        const changed: Record<string, string> = {};
                        for (const [k, v] of Object.entries(cvForm)) {
                          if (k === "surveyRaw") continue; // managed by the row editor below
                          if ((f.cv[k] ?? "") !== v) changed[k] = v;
                        }
                        if (surveyDirty) changed.surveyRaw = serializeSurvey(surveyRows);
                        const extras: Record<string, string> = {};
                        for (const [k, v] of Object.entries(extrasForm)) {
                          if (v.trim()) extras[k] = v;
                        }
                        if (!Object.keys(changed).length && !Object.keys(extras).length) { setToast("Nothing changed"); return; }
                        if (Object.keys(changed).length) void act("cvs", f.slug, { values: JSON.stringify(changed) });
                        if (Object.keys(extras).length) void act("extras", f.slug, extras);
                      }}
                      disabled={busy === `cvs:${f.slug}` || busy === `extras:${f.slug}`}
                      className={cn("text-xs rounded-lg px-3 py-2 text-white font-medium disabled:opacity-80 inline-flex items-center gap-1.5 transition-colors",
                        savedFlash === f.slug ? "bg-[#15803d]" : "bg-[#0e9c9c]")}>
                      {busy === `cvs:${f.slug}` || busy === `extras:${f.slug}`
                        ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…</>
                        : savedFlash === f.slug
                          ? <><Check className="w-3.5 h-3.5" /> Saved ✓</>
                          : "Save to GHL"}
                    </button>
                  </div>
                  <div className="border-t border-[#eef2f6] pt-3 grid gap-1 justify-items-start">
                    <p className="text-[11px] font-bold text-[#0b7f7f]">Step 4 &middot; Verify the setup</p>
                    <button onClick={() => void act("health", f.slug)} disabled={busy === `health:${f.slug}`}
                      className="text-xs border border-[#e4ebf2] rounded-lg px-3 py-2 hover:bg-white inline-flex items-center gap-1.5 bg-white font-medium">
                      {busy === `health:${f.slug}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Stethoscope className="w-3.5 h-3.5" />}
                      Run verification
                    </button>
                    {health[f.slug] ? (
                      <div className="w-full grid md:grid-cols-2 gap-1 mt-1">
                        {health[f.slug].map((c) => (
                          <div key={c.name} className="text-xs flex items-center gap-2">
                            {c.ok ? <Check className="w-3.5 h-3.5 text-[#15803d]" /> : <X className="w-3.5 h-3.5 text-[#b91c1c]" />}
                            <span className="text-[#1c2b3a]">{c.name}</span>
                            <span className="text-[#697a91]">— {c.note}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span className="text-[10px] text-[#697a91]">Every line should come back green before going live.</span>
                    )}
                  </div>
                  {/* Step 5 — the ads already carry the client's GHL funnel link
                      and that link must NOT change (a new ad URL resets Meta's
                      learning phase), so most launches need a GHL URL Redirect
                      from the ad link onto this funnel (user, 2026-09-19). The
                      SOP is the zero-flash cutover: rename the old page to -old
                      (keeps a rollback copy), then 301 the original path here.
                      Verified live before Go live, in that order. */}
                  {(() => {
                    const adPath = (() => { try { return new URL(adUrlForm.trim()).pathname.replace(/\/+$/, ""); } catch { return ""; } })();
                    const verifiedNow = !!redirectVerify?.ok;
                    const verifiedBefore = !!f.redirectVerifiedAt && f.adRedirect === "yes";
                    const needsVerify = redirectChoice === "yes" && !verifiedNow && !verifiedBefore;
                    const pick = (v: "yes" | "no") => {
                      setRedirectChoice(v); setRedirectVerify(null);
                      if (v !== f.adRedirect) void act("extras", f.slug, { adRedirect: v });
                    };
                    return (<>
                  <div className="border-t border-[#eef2f6] pt-3 grid gap-1.5 justify-items-start">
                    <p className="text-[11px] font-bold text-[#0b7f7f]">Step 5 &middot; Redirect the ad link here?</p>
                    <div className="flex flex-wrap gap-1.5">
                      <button type="button" onClick={() => pick("yes")}
                        className={cn("text-xs rounded-lg px-3 py-1.5 border font-medium",
                          redirectChoice === "yes" ? "bg-[#0e9c9c] text-white border-[#0e9c9c]" : "border-[#e4ebf2] bg-white hover:bg-[#f6f9fc] text-[#1c2b3a]")}>
                        Yes — redirect the GHL link
                      </button>
                      <button type="button" onClick={() => pick("no")}
                        className={cn("text-xs rounded-lg px-3 py-1.5 border font-medium",
                          redirectChoice === "no" ? "bg-[#0e9c9c] text-white border-[#0e9c9c]" : "border-[#e4ebf2] bg-white hover:bg-[#f6f9fc] text-[#1c2b3a]")}>
                        No — the ads will use the one-box link directly
                      </button>
                    </div>
                    {redirectChoice === "yes" && (
                      <div className="w-full border border-[#e4ebf2] rounded-xl p-3 grid gap-2 text-xs bg-white">
                        <label className="grid gap-0.5">
                          <span className="text-[10px] font-medium text-[#697a91]">Ad link (the GHL funnel URL running in the ads)</span>
                          <input value={adUrlForm} placeholder="https://pmu-care.com/care-pmu-survey-12"
                            onChange={(e) => { setAdUrlForm(e.target.value); setRedirectVerify(null); }}
                            className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-xs" />
                        </label>
                        <div className="grid gap-1.5 text-[#697a91]">
                          <label className="flex items-start gap-2 cursor-pointer">
                            <input type="checkbox" className="mt-0.5" checked={sop5.renamed}
                              onChange={(e) => { setSop5((x) => ({ ...x, renamed: e.target.checked })); setRedirectVerify(null); }} />
                            <span>1. Survey step path: add <CopyChip text="-old" onCopied={() => setToast("Copied ✓")} /> at the end.</span>
                          </label>
                          <label className="flex items-start gap-2 cursor-pointer">
                            <input type="checkbox" className="mt-0.5" checked={sop5.redirect}
                              onChange={(e) => { setSop5((x) => ({ ...x, redirect: e.target.checked })); setRedirectVerify(null); }} />
                            <span>2. URL Redirect:{" "}
                              {adPath ? <CopyChip text={adPath} onCopied={() => setToast("Copied ✓")} /> : <i>paste the ad link above first</i>}
                              {" "}&rarr;{" "}
                              <CopyChip text={f.url.replace(`.com/${f.slug}`, `.com/s/${f.slug}`)} onCopied={() => setToast("Copied ✓")} /></span>
                          </label>
                          <label className="flex items-start gap-2 cursor-pointer">
                            <input type="checkbox" className="mt-0.5" checked={sop5.workflow}
                              onChange={(e) => { setSop5((x) => ({ ...x, workflow: e.target.checked })); setRedirectVerify(null); }} />
                            <span>3. Workflow <b>CC- Funnel Survey</b>: add a Contact Tag trigger{" "}
                              <CopyChip text="onebox-survey" onCopied={() => setToast("Copied ✓")} />
                              {" "}(+ the same tag as an OR condition in the program branch), Publish.</span>
                          </label>
                          <span>4. Verify, then Go live.</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <button type="button" onClick={() => void verifyRedirect(f.slug)}
                            disabled={!!redirectVerify?.loading || !(sop5.renamed && sop5.redirect && sop5.workflow)}
                            title={!(sop5.renamed && sop5.redirect && sop5.workflow) ? "Tick the three GHL steps first" : undefined}
                            className="text-xs rounded-lg px-3 py-2 bg-[#0e9c9c] text-white font-medium disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5">
                            {redirectVerify?.loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Stethoscope className="w-3.5 h-3.5" />}
                            {redirectVerify?.checks ? "Re-check" : "Verify redirect"}
                          </button>
                          {verifiedBefore && !redirectVerify?.checks && (
                            <span className="text-[#15803d]">&#10004; verified {new Date(f.redirectVerifiedAt as string).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                          )}
                        </div>
                        {redirectVerify?.error && <span className="text-[#b91c1c]">{redirectVerify.error}</span>}
                        {redirectVerify?.checks && !redirectVerify.loading && (
                          <div className="grid gap-0.5">
                            <span className={redirectVerify.checks.redirectLive ? "text-[#15803d]" : "text-[#b91c1c]"}>
                              {redirectVerify.checks.redirectLive
                                ? `✓ Ad link redirects to ${redirectVerify.target}`
                                : `✗ ${redirectVerify.checks.redirectNote}`}
                            </span>
                            <span className={redirectVerify.checks.originalKept ? "text-[#15803d]" : "text-[#697a91]"}>
                              {redirectVerify.checks.originalKept ? "✓ " : "· "}{redirectVerify.checks.originalNote}
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                    {redirectChoice === "no" && (
                      <span className="text-[10px] text-[#697a91]">OK — no redirect. Use <b>{f.url}</b> in the ads.</span>
                    )}
                  </div>
                  <div className="border-t border-[#eef2f6] pt-3 grid gap-1 justify-items-start">
                    <p className="text-[11px] font-bold text-[#0b7f7f]">Step 6 &middot; Go live</p>
                    {f.status === "live" ? (
                      <span className="text-xs font-medium text-[#15803d]">&#10004; This funnel is live</span>
                    ) : (
                      <>
                        <button onClick={() => void act("status", f.slug, { status: "live" })}
                          disabled={busy === `status:${f.slug}` || needsVerify}
                          title={needsVerify ? "Verify the redirect in Step 5 first" : undefined}
                          className="ob-golive text-xs rounded-lg px-3 py-2 border font-medium border-[#bfe3cd] text-[#15803d] bg-[#e7f6ec] hover:bg-[#d6f0df] disabled:opacity-40 disabled:cursor-not-allowed">
                          Go live
                        </button>
                        {needsVerify
                          ? <span className="text-[10px] text-[#c2410c]">Verify the redirect in Step 5 first — ad clicks are already switching over, so go live right after it passes.</span>
                          : verifiedNow
                            ? <span className="text-[10px] text-[#15803d]">Redirect is live — go live now so the ad clicks land on the new funnel.</span>
                            : null}
                      </>
                    )}
                  </div>
                    </>);
                  })()}
                  {isAdmin && (
                    <div className="border-t border-[#eef2f6] pt-2">
                      <button onClick={() => { const open = abFor === f.slug; setAbFor(open ? null : f.slug); if (!open) { if (!abOrigUrl) setAbOrigUrl(f.oldFunnelUrl || ""); void loadAb(f.slug); } }}
                        className="text-[11px] text-[#697a91] hover:text-[#1c2b3a] hover:underline">
                        Advanced &middot; Split test vs the original GHL funnel {abFor === f.slug ? "▲" : "▸"}
                      </button>
                    </div>
                  )}
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
                              const target = abOrigUrl.trim();
                              if (!target) { setToast("Add the original funnel URL under Start Setup first"); return; }
                              void abAct(f.slug, {
                                action: "create", slug: f.slug, name: "Original vs One-Box",
                                variants: [
                                  { vkey: "a", label: "Original GHL funnel", kind: "external", target, weight: 50 },
                                  { vkey: "b", label: "One-box funnel", kind: "onebox", weight: 50 },
                                ],
                              });
                            }}
                            disabled={abBusy || !startVerify?.ok || verifySlug !== f.slug}
                            className="justify-self-start text-xs rounded-lg px-3 py-2 bg-[#0e9c9c] text-white font-medium disabled:opacity-40 disabled:cursor-not-allowed">
                            {startVerify?.ok && verifySlug === f.slug ? "Verified — start 50/50 test" : "Start 50/50 test (verify first)"}
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
                                      : v.kind === "external" ? <span className="text-[10px] text-[#97a5b8]" title="This side's deposits live in Commas — not visible from here (not zero)">in Commas</span> : "—"}
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
                    </div>
                  )}
                </div>
              )}

            </div>
            </Fragment>
          ))}
          {/* Optimizer lives at the very bottom of the tab (user, 2026-09-14) —
              the funnels themselves come first. Admins only. */}
          {isAdmin && (
          <div className="border border-[#f0c987] rounded-xl bg-white p-4">
            <button onClick={() => setOptimizerOpen(!optimizerOpen)}
              className="w-full flex flex-wrap items-center gap-2 text-sm font-medium text-[#1c2b3a]">
              🧠 Optimizer — B2C funnels
              {insights && insights.open.length > 0 && (
                <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 bg-[#fff3e6] text-[#c2410c] border border-[#fdba74]">
                  {insights.open.length} flag{insights.open.length === 1 ? "" : "s"} waiting for you
                </span>
              )}
              <span className="ml-auto text-[#697a91]">{optimizerOpen ? "▲" : "▼"}</span>
            </button>
            {optimizerOpen && (<>
            <div className="flex flex-wrap items-center gap-2 mt-1">
              <p className="text-[11px] text-[#697a91]">
                Watches every live B2C funnel daily, optimizing for deposits. Once a client has enough data it flags the
                problem, the evidence, and a fix. Approving records the plan — it does not run the fix; a person (or Claude, when asked) does.
              </p>
              <div className="flex-1" />
              <button onClick={() => void scanNow()} disabled={scanBusy}
                className="text-xs border border-[#e4ebf2] rounded-lg px-2.5 py-1 hover:bg-[#f6f9fc] inline-flex items-center gap-1.5 disabled:opacity-50">
                {scanBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : null} Scan now
              </button>
            </div>
            {insights === null ? (
              <div className="mt-2 text-xs text-[#697a91]"><Loader2 className="w-3.5 h-3.5 animate-spin inline" /></div>
            ) : insights.open.length === 0 ? (
              <div className="mt-2 text-xs text-[#697a91]">No open flags — every funnel is inside its normal range right now.</div>
            ) : (
              <div className="mt-2 space-y-2">
                {insights.open.map((ins) => (
                  <div key={ins.id} className="border border-[#f4dcb8] rounded-lg bg-[#fffcf6] p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <b className="text-sm text-[#1c2b3a]">{ins.clientName}</b>
                      <span className="text-[13px] font-medium text-[#b45309]">{ins.problem}</span>
                    </div>
                    <div className="text-xs text-[#425466] mt-1"><b className="text-[#697a91]">Why:</b> {ins.why}</div>
                    <div className="text-xs text-[#425466] mt-1"><b className="text-[#0b7f7f]">Fix I suggest:</b> {ins.solution}</div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button onClick={() => void decideInsight(ins.id, "approve")} disabled={decideBusy === ins.id}
                        className="text-xs bg-[#0e9c9c] text-white rounded-md px-3 py-1 hover:bg-[#0b8383] disabled:opacity-50 inline-flex items-center gap-1">
                        {decideBusy === ins.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Approve
                      </button>
                      <button onClick={() => { setDenyFor(denyFor === ins.id ? null : ins.id); setDenyReason(""); setDenySuggestion(""); }}
                        className={cn("text-xs border rounded-md px-3 py-1",
                          denyFor === ins.id ? "border-[#fca5a5] bg-[#fef2f2] text-[#b91c1c]" : "border-[#e4ebf2] hover:bg-white text-[#697a91]")}>
                        Deny…
                      </button>
                    </div>
                    {denyFor === ins.id && (
                      <div className="mt-2 grid gap-1.5">
                        <input placeholder="Why deny? (required if no suggestion)" value={denyReason}
                          onChange={(e) => setDenyReason(e.target.value)}
                          className="border border-[#e4ebf2] rounded-md px-2.5 py-1.5 text-xs" />
                        <input placeholder="Or suggest a different fix — we'll do yours instead (optional)" value={denySuggestion}
                          onChange={(e) => setDenySuggestion(e.target.value)}
                          className="border border-[#e4ebf2] rounded-md px-2.5 py-1.5 text-xs" />
                        <button onClick={() => void decideInsight(ins.id, "deny", denyReason, denySuggestion)}
                          disabled={decideBusy === ins.id || (!denyReason.trim() && !denySuggestion.trim())}
                          className="justify-self-start text-xs border border-[#fca5a5] text-[#b91c1c] rounded-md px-3 py-1 hover:bg-[#fef2f2] disabled:opacity-40">
                          Confirm deny
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {insights && insights.decided.length > 0 && (
              <div className="mt-2">
                <button onClick={() => setShowDecided(!showDecided)} className="text-[11px] text-[#697a91] hover:underline">
                  {showDecided ? "▲ hide" : "▼ show"} recent decisions ({insights.decided.length})
                </button>
                {showDecided && (
                  <div className="mt-1 space-y-1">
                    {insights.decided.map((ins) => (
                      <div key={ins.id} className="text-[11px] text-[#697a91]">
                        <span className={ins.status === "approved" ? "text-[#15803d]" : "text-[#b91c1c]"}>
                          {ins.status === "approved" ? "✓ approved" : "✗ denied"}
                        </span>{" "}
                        <b className="text-[#425466]">{ins.clientName}</b> — {ins.problem}
                        {ins.deny_reason ? <span className="italic"> · “{ins.deny_reason}”</span> : null}
                        {ins.user_suggestion ? <span className="italic"> · your fix: “{ins.user_suggestion}”</span> : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            </>)}
          </div>
          )}
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
