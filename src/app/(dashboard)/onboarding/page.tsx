"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, ChevronLeft, ChevronRight, Trash2, ExternalLink, Check } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { ONBOARDING_STEPS, SECTION_ORDER, FORM_FIELDS, OFFER_OPTIONS, SERVICE_OPTIONS, formSections, type OnboardingStep } from "@/lib/onboarding-steps";
import { useUser } from "@/lib/hooks/useUser";
import { CleanupPanel } from "@/components/cleanup/CleanupPanel";
import { SetupRunPanel } from "@/components/onboarding/SetupRunPanel";
import { MacMiniTracker } from "@/components/agent/MacMiniTracker";

// Same version colors as the Clients tab: V3 solid blue, V2.3 light purple.
const VERSION_PILLS: { value: string; label: string; on: string; off: string }[] = [
  { value: "(V3)", label: "V3", on: "bg-[#1d4ed8] border-[#1d4ed8] text-white", off: "border-[#93c5fd] text-[#1d4ed8] hover:bg-[#eff6ff]" },
  { value: "(V2.3)", label: "V2.3", on: "bg-[#f3e8ff] border-[#e3cffb] text-[#7e22ce]", off: "border-[#e3cffb] text-[#7e22ce] hover:bg-[#faf5ff]" },
];

interface ClaimAction { action: string; ok: boolean; detail?: string }
interface Claim {
  location_id: string;
  original_name: string;
  business_name: string;
  claimed_at: string;
  claimed_by: string;
  actions: ClaimAction[];
}
interface Onboarding {
  id: string;
  created_at: string;
  created_by: string | null;
  status: string;
  form: Record<string, string>;
  checklist: Record<string, { done: boolean; by: string; at: string }>;
  claim?: Claim | null;
  setup?: { status: string } | null; // the New Client Setup run (full state is loaded by its panel)
}

function stepsFor(o: Onboarding): OnboardingStep[] {
  const isV3 = String(o.form.version ?? "").toLowerCase().includes("v3") && !String(o.form.version ?? "").toLowerCase().includes("v2.3");
  return ONBOARDING_STEPS.filter((s) => !s.v3Only || isV3);
}
/* Owner 10/22/2026: the bar reads 90% when everything up to Facebook is
   done; the whole Facebook part (BM + campaign) is the last 10%. */
const isFb = (s: OnboardingStep) => /^facebook/i.test(s.section);
function progress(o: Onboarding): { done: number; total: number; pct: number } {
  const steps = stepsFor(o).filter((s) => s.section !== "Later");
  const done = steps.filter((s) => o.checklist[s.key]?.done).length;
  const part = (list: OnboardingStep[]) => (list.length ? list.filter((s) => o.checklist[s.key]?.done).length / list.length : 1);
  const pct = Math.round(90 * part(steps.filter((s) => !isFb(s))) + 10 * part(steps.filter(isFb)));
  return { done, total: steps.length, pct };
}

// Image field: upload to the dashboard (public URL) or paste a URL — either
// way the claim writes the URL into the GHL custom value the funnel renders.
function ImageField({ value, onChange }: { value: string; onChange: (url: string) => void }) {
  const [uploading, setUploading] = useState(false);
  const pick = useCallback(async (file: File | null) => {
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/onboarding/upload", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Upload failed");
      onChange(json.url);
      toast.success("Image uploaded");
    } catch (e) {
      toast.error(`${e}`.replace("Error: ", ""));
    } finally {
      setUploading(false);
    }
  }, [onChange]);
  return (
    <div className="flex items-center gap-2">
      {value ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={value} alt="" className="w-9 h-9 rounded-lg object-cover border border-[#d7e0ea] shrink-0" />
      ) : null}
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder="Upload or paste an image URL"
        className="flex-1 min-w-0 px-3 py-2 bg-white border border-[#d7e0ea] rounded-lg text-xs text-[#1f3559] focus:outline-none focus:border-[#15B7AE]" />
      <label className={cn("shrink-0 px-2.5 py-2 rounded-lg text-xs font-semibold cursor-pointer border", uploading ? "opacity-50 pointer-events-none border-[#d7e0ea] text-[#8595a8]" : "border-[#a7e3df] text-[#0e8f88] hover:bg-[#f7fdfc]")}>
        {uploading ? <Loader2 size={13} className="animate-spin inline" /> : "Upload"}
        <input type="file" accept="image/*" className="hidden" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
      </label>
      {value && (
        <button type="button" onClick={() => onChange("")} title="Remove" className="shrink-0 p-1.5 rounded text-[#94a3b8] hover:text-[#e11d48]"><Trash2 size={13} /></button>
      )}
    </div>
  );
}

export default function OnboardingPage() {
  const { role } = useUser();
  // Old /cleanup bookmarks arrive as /onboarding#cleanup — open the section.
  const [cleanupOpen, setCleanupOpen] = useState(false);
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.hash === "#cleanup") setCleanupOpen(true);
  }, []);
  // /onboarding?open=<card id> — the Clients tab's "Set up account" lands here.
  const [openFromUrl] = useState<string | null>(() => (typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("open") : null));
  const [list, setList] = useState<Onboarding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  // Auto-verify: per-step {status, detail} keyed by step key, + running state.
  const [verifying, setVerifying] = useState(false);
  const [verifyBy, setVerifyBy] = useState<Record<string, { status: string; detail: string }>>({});
  const [verifiedAt, setVerifiedAt] = useState<string | null>(null);

  const runVerify = useCallback(async (id: string) => {
    setVerifying(true);
    try {
      const res = await fetch(`/api/onboarding/${id}/verify`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Verify failed");
      const map: Record<string, { status: string; detail: string }> = {};
      for (const c of (json.checks ?? []) as { key: string; status: string; detail: string }[]) map[c.key] = { status: c.status, detail: c.detail };
      setVerifyBy(map);
      setVerifiedAt(json.ranAt ?? new Date().toISOString());
      const pass = Object.values(map).filter((c) => c.status === "pass").length;
      const fail = Object.values(map).filter((c) => c.status === "fail").length;
      toast[fail ? "error" : "success"](`Setup check: ${pass} passed, ${fail} problem${fail === 1 ? "" : "s"}`);
    } catch (e) { toast.error(`${e}`.replace("Error: ", "")); }
    finally { setVerifying(false); }
  }, []);
  // Clear verify results when switching to a different onboarding.
  useEffect(() => { setVerifyBy({}); setVerifiedAt(null); }, [openId]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch("/api/onboarding");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setList(json.onboardings ?? []);
      if (openFromUrl && (json.onboardings ?? []).some((o: Onboarding) => o.id === openFromUrl)) setOpenId(openFromUrl);
    } catch (e) {
      setError(`${e}`.replace("Error: ", ""));
    } finally {
      setLoading(false);
    }
  }, [openFromUrl]);
  useEffect(() => { load(); }, [load]);

  const create = useCallback(async () => {
    setCreating(true);
    try {
      const res = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ form }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Create failed");
      setList((l) => [json.onboarding, ...l]);
      setShowForm(false);
      setForm({});
      setOpenId(json.onboarding.id);
      toast.success(`Onboarding started for ${json.onboarding.form.business_name}`);
    } catch (e) {
      toast.error(`${e}`.replace("Error: ", ""));
    } finally {
      setCreating(false);
    }
  }, [form]);

  const toggleStep = useCallback(async (o: Onboarding, stepKey: string, done: boolean) => {
    // optimistic
    setList((l) => l.map((x) => x.id === o.id
      ? { ...x, checklist: done
          ? { ...x.checklist, [stepKey]: { done: true, by: "you", at: new Date().toISOString() } }
          : Object.fromEntries(Object.entries(x.checklist).filter(([k]) => k !== stepKey)) }
      : x));
    try {
      const res = await fetch(`/api/onboarding/${o.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stepKey, done }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      setList((l) => l.map((x) => (x.id === o.id ? json.onboarding : x)));
    } catch (e) {
      toast.error(`Couldn't save: ${e}`);
      load();
    }
  }, [load]);

  const setStatus = useCallback(async (o: Onboarding, status: string) => {
    setList((l) => l.map((x) => (x.id === o.id ? { ...x, status } : x)));
    try {
      const res = await fetch(`/api/onboarding/${o.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Save failed");
      toast.success(status === "done" ? "Onboarding marked complete 🎉" : "Status updated");
    } catch (e) {
      toast.error(`${e}`.replace("Error: ", ""));
      load();
    }
  }, [load]);

  const remove = useCallback(async (o: Onboarding) => {
    if (!window.confirm(`Delete the onboarding for ${o.form.business_name}? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/onboarding/${o.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error || "Delete failed");
      setList((l) => l.filter((x) => x.id !== o.id));
      setOpenId(null);
      toast.success("Deleted");
    } catch (e) {
      toast.error(`${e}`.replace("Error: ", ""));
    }
  }, []);

  const open = useMemo(() => list.find((o) => o.id === openId) ?? null, [list, openId]);

  const [claiming, setClaiming] = useState(false);

  // Clean accounts ready for a setup. Read-only inventory, shown to everyone
  // who opens this tab — whoever is doing the setup is the one who needs to
  // know what's actually available.
  const [poolInfo, setPoolInfo] = useState<{
    ready: Array<{ location_id: string; pool_name: string; clean_checked_at: string | null }>;
    notReady: Array<{ pool_name: string; blocker: string | null }>;
    counts: { ready: number; notReady: number; total: number };
    checkedAt?: string | null;
    syncError?: string | null;
  } | null>(null);
  const [poolBusy, setPoolBusy] = useState(true);
  // Refresh re-checks GoHighLevel (sync=1); a plain load reads the table and
  // the API re-checks on its own when that is over an hour old. Before
  // 2026-09-29 Refresh only re-read the table, so it never changed anything.
  const loadPool = useCallback(async (opts?: { sync?: boolean }) => {
    setPoolBusy(true);
    try {
      const r = await fetch(opts?.sync ? "/api/pool?sync=1" : "/api/pool");
      const j = await r.json();
      if (r.ok) {
        setPoolInfo(j);
        if (opts?.sync) {
          if (j.syncError) toast.error(`Could not re-check GoHighLevel: ${j.syncError}`);
          else toast.success(`Re-checked GoHighLevel — ${j.counts.total} clean accounts left, ${j.counts.ready} ready`);
        }
      } else if (opts?.sync) toast.error(j.error || "Refresh failed");
    } catch {
      if (opts?.sync) toast.error("Refresh failed — check your connection");
    }
    setPoolBusy(false);
  }, []);
  useEffect(() => { loadPool(); }, [loadPool, claiming]);
  // A cleaned account just joined the pool — re-count from GoHighLevel.
  const refreshPoolAfterClean = useCallback(() => { void loadPool({ sync: true }); }, [loadPool]);
  // The old Claim button is gone (owner 10/20/2026) — the setup run takes the account.
  const unclaim = useCallback(async (o: Onboarding) => {
    if (!o.claim) return;
    if (!window.confirm(`Un-claim: rename "${o.claim.business_name}" back to "${o.claim.original_name}"?`)) return;
    setClaiming(true);
    try {
      const res = await fetch(`/api/onboarding/${o.id}/claim`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Un-claim failed");
      setList((l) => l.map((x) => (x.id === o.id ? json.onboarding : x)));
      toast.success("Account returned to the pool");
    } catch (e) {
      toast.error(`${e}`.replace("Error: ", ""));
    } finally {
      setClaiming(false);
    }
  }, []);

  // ── Detail view ──────────────────────────────────────────────────────────
  if (open) {
    const steps = stepsFor(open);
    const pr = progress(open);
    const pct = pr.pct;
    return (
      <div className="p-4 sm:p-6 space-y-4 max-w-[1600px]">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <button onClick={() => setOpenId(null)} className="flex items-center gap-1 text-xs text-[#0e8f88] hover:underline mb-1">
              <ChevronLeft size={13} /> All onboardings
            </button>
            <h1 className="text-xl font-bold text-[#1f3559] flex items-baseline gap-2 flex-wrap"><span>{open.form.business_name}</span>
            <span className="text-sm font-normal text-[#697a91]">{open.form.owner_name} · {open.form.version || "—"} · started {new Date(open.created_at).toLocaleDateString("en-US")}{open.created_by ? ` by ${open.created_by.split("@")[0]}` : ""}
              {/* The setup run puts its account line here (Clean New Account N → business · GHL · funnel). */}
              <span id="setup-meta-slot" /></span></h1>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => runVerify(open.id)} disabled={verifying}
              title="Auto-check the funnel, payment and account setup"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#4f46e5] hover:bg-[#4338ca] text-white disabled:opacity-50">
              {verifying ? <Loader2 size={13} className="animate-spin" /> : "🤖"} Verify setup
            </button>
            {open.status !== "done" && pct === 100 && (
              <button onClick={() => setStatus(open, "done")}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#15B7AE] hover:bg-[#0e8f88] text-white">
                <Check size={13} /> Mark Complete
              </button>
            )}
            {open.status === "done" && <span className="px-2.5 py-1 rounded-lg text-xs font-bold bg-[#e6f7ee] text-[#15803d] border border-[#86efac]">✓ Complete</span>}
            {open.claim && role === "admin" && (
              <button onClick={() => unclaim(open)} disabled={claiming} title={`Rename "${open.claim.business_name}" back to "${open.claim.original_name}" and return it to the pool`}
                className="px-2 py-1 text-[11px] font-semibold rounded-lg text-[#e11d48] hover:bg-[#fde8ee] disabled:opacity-50">
                {claiming ? <Loader2 size={12} className="animate-spin inline" /> : "Un-claim"}
              </button>
            )}
            <button onClick={() => remove(open)} title="Delete onboarding"
              className="p-2 rounded-lg text-[#94a3b8] hover:text-[#e11d48] hover:bg-[#fde8ee]"><Trash2 size={15} /></button>
          </div>
        </div>

        {/* Progress */}
        <div className="rounded-xl border border-[#e4ebf2] bg-white p-3">
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="font-semibold text-[#34568a]">{pr.done} of {pr.total} steps done</span>
            <span className="font-bold text-[#0e8f88]">{pct}%</span>
          </div>
          <div className="h-2.5 rounded-full bg-[#f1f5f9] overflow-hidden">
            <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: pct === 100 ? "#15803d" : "#15B7AE" }} />
          </div>
        </div>

        {/* Auto-verify summary */}
        {verifiedAt && (() => {
          const vals = Object.values(verifyBy);
          const pass = vals.filter((v) => v.status === "pass").length;
          const fail = vals.filter((v) => v.status === "fail").length;
          const manual = vals.filter((v) => v.status === "manual").length;
          const fails = Object.entries(verifyBy).filter(([, v]) => v.status === "fail");
          return (
            <div className={cn("rounded-xl border p-3", fail ? "border-[#fcd9a8] bg-[#fffdf7]" : "border-[#86efac] bg-[#f0fdf4]")}>
              <div className="flex items-center gap-2 text-sm font-bold text-[#1f3559]">
                🤖 Setup check
                <span className="text-[#15803d]">{pass} passed</span>
                {fail > 0 && <span className="text-[#c2410c]">· {fail} problem{fail === 1 ? "" : "s"}</span>}
                <span className="text-[#8595a8] font-normal">· {manual} manual · {new Date(verifiedAt).toLocaleTimeString("en-US")}</span>
              </div>
              {fails.length > 0 && (
                <ul className="mt-1.5 space-y-0.5">
                  {fails.map(([k, v]) => (
                    <li key={k} className="text-[11px] text-[#c2410c]">✗ {ONBOARDING_STEPS.find((s) => s.key === k)?.label ?? k} — {v.detail}</li>
                  ))}
                </ul>
              )}
            </div>
          );
        })()}

        {/* Client details */}
        <details open className="rounded-xl border border-[#e4ebf2] bg-white">
          <summary className="px-4 py-2.5 text-sm font-semibold text-[#34568a] cursor-pointer">Client details (from the form)</summary>
          <div className="px-4 pb-3 grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-2">
            {FORM_FIELDS.filter((f) => (open.form[f.key] ?? "").trim()).map((f) => (
              <div key={f.key} className="min-w-0">
                <p className="text-[10px] uppercase tracking-wide text-[#8595a8]">{f.label}</p>
                <p className="text-sm text-[#1f3559] break-words">{open.form[f.key]}</p>
              </div>
            ))}
          </div>
        </details>

        {/* New Client Setup run — approve first, then the AI Agent does the steps */}
        <SetupRunPanel onboardingId={open.id} role={role} form={open.form} onChanged={() => void load()} />

        {/* Owner 10/22/2026: the manual checklist (checkboxes + videos) stays folded —
            open it only to do a step by hand when the Mac Mini is not working. */}
        <details className="rounded-xl border border-[#e4ebf2] bg-white">
          <summary className="px-4 py-2.5 text-sm font-semibold text-[#34568a] cursor-pointer">🛠 Manual setup checklist (only if the AI Agent is not working)</summary>
          <div className="p-3 space-y-4">
        {/* Checklist by section */}
        {SECTION_ORDER.map((section) => {
          const secSteps = steps.filter((s) => s.section === section);
          if (!secSteps.length) return null;
          const secDone = secSteps.filter((s) => open.checklist[s.key]?.done).length;
          return (
            <div key={section} className="rounded-xl border border-[#e4ebf2] bg-white overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 bg-[#f8fafc] border-b border-[#eef3f8]">
                <h2 className="text-sm font-bold text-[#1f3559]">{section}</h2>
                <span className={cn("text-xs font-semibold", secDone === secSteps.length ? "text-[#15803d]" : "text-[#8595a8]")}>{secDone}/{secSteps.length}</span>
              </div>
              <ul className="divide-y divide-[#f1f5f9]">
                {secSteps.map((s) => {
                  const state = open.checklist[s.key];
                  const v = verifyBy[s.key];
                  return (
                    <li key={s.key} className="flex items-start gap-2.5 px-4 py-2">
                      <button onClick={() => toggleStep(open, s.key, !state?.done)}
                        className={cn("mt-0.5 shrink-0 w-5 h-5 rounded-md border flex items-center justify-center transition-colors",
                          state?.done ? "bg-[#15B7AE] border-[#15B7AE] text-white" : "border-[#cbd5e1] hover:border-[#15B7AE] text-transparent")}>
                        <Check size={12} />
                      </button>
                      <div className="min-w-0 flex-1">
                        <p className={cn("text-sm", state?.done ? "text-[#8595a8] line-through" : "text-[#1f3559]")}>
                          {s.label}
                          {v && v.status !== "skip" && (
                            <span title={v.detail}
                              className={cn("ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase",
                                v.status === "pass" ? "bg-[#e6f7ee] text-[#15803d]"
                                  : v.status === "fail" ? "bg-[#fde8ee] text-[#e11d48]"
                                  : "bg-[#f1f5f9] text-[#64748b]")}>
                              {v.status === "pass" ? "✓ verified" : v.status === "fail" ? "✗ problem" : "manual"}
                            </span>
                          )}
                          {!v && s.auto && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-[#eef2ff] text-[#4f46e5]" title="Auto-checked by the Verify setup button">auto</span>}
                        </p>
                        {v && v.status === "fail" && <p className="text-[10px] text-[#e11d48] mt-0.5">{v.detail}</p>}
                        {state?.done && <p className="text-[10px] text-[#a6b3c4]">✓ {state.by.split("@")[0]} · {new Date(state.at).toLocaleDateString("en-US")}</p>}
                      </div>
                      {(s.loom || s.doc) && (
                        <span className="shrink-0 flex items-center gap-2">
                          {s.loom && (
                            <a href={s.loom} target="_blank" rel="noopener noreferrer" title="Watch the how-to video"
                              className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-[#e6f7f5] text-[#0e8f88] hover:bg-[#d3f1ed]">
                              ▶ Video
                            </a>
                          )}
                          {s.doc && (
                            <a href={s.doc} target="_blank" rel="noopener noreferrer" title={s.docLabel ?? "Open the guide"}
                              className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-[#eef2ff] text-[#3a5a8c] hover:bg-[#e0e7ff]">
                              <ExternalLink size={11} /> {s.docLabel ?? "Guide"}
                            </a>
                          )}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
          </div>
        </details>
      </div>
    );
  }

  // ── List + create form (left) · Check Setup (right) ──────────────────────
  // The per-client checklist (the team's Onboarding sheet, step for step,
  // with its videos) is back on since 2026-10-07 — owner: "my team checks
  // every step one by one so nothing is missed". Check Setup stays on the right.
  const SHOW_ONBOARDING_LIST = true;
  return (
    <div className="p-4 sm:p-6">
      {/* The Mac Mini's setup steps + snapshot loads (owner, 2026-10-16). */}
      <MacMiniTracker scope="onboarding" />
      {/* Available clean accounts — the first thing you need before a setup. */}
      <div className="max-w-5xl mx-auto mb-4 rounded-xl border border-[#e2e8f0] bg-white p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-[#15803d]">
              {poolBusy && !poolInfo ? "…" : poolInfo?.counts.ready ?? 0}
            </span>
            <span className="text-sm font-semibold text-[#1e2b3d]">clean accounts ready for a setup</span>
            {poolInfo && (
              <span className="text-xs text-[#697a91]">
                · {poolInfo.counts.total} left in total
                {poolInfo.checkedAt ? ` · checked ${new Date(poolInfo.checkedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <a href="/onboarding/make-routes"
              className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#f1f5f9] hover:bg-[#e6f7f5] text-[#34568a] border border-[#e4ebf2]">
              🔀 Make routes
            </a>
            <button onClick={() => void loadPool({ sync: true })} disabled={poolBusy}
              title="Re-check GoHighLevel for which clean accounts are still unclaimed"
              className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#f1f5f9] hover:bg-[#e6f7f5] text-[#34568a] border border-[#e4ebf2] disabled:opacity-50 flex items-center gap-1.5">
              {poolBusy && <Loader2 size={12} className="animate-spin" />}
              {poolBusy ? "Checking…" : "Refresh"}
            </button>
          </div>
        </div>

        {poolInfo && poolInfo.ready.length > 0 && (
          <>
            <div className="flex flex-wrap gap-1.5 mt-3">
              {poolInfo.ready.map((p) => (
                <span key={p.location_id}
                  title={p.clean_checked_at ? `Verified empty and A2P-approved · checked ${new Date(p.clean_checked_at).toLocaleString("en-US")}` : undefined}
                  className="px-2 py-1 rounded-md text-[11px] font-medium border bg-[#e7f6ec] text-[#15803d] border-[#bfe3cd]">
                  {p.pool_name}
                </span>
              ))}
            </div>
            <p className="text-[11px] text-[#9aa8bc] mt-2">
              Empty and A2P-approved — safe to use. Take the lowest number first.
            </p>
          </>
        )}

        {poolInfo && poolInfo.ready.length === 0 && !poolBusy && (
          <p className="text-xs text-[#d97706] mt-2">
            ⚠ No clean accounts are ready right now. {poolInfo.counts.notReady > 0
              ? `${poolInfo.counts.notReady} are in the pool but not usable yet — see below.`
              : "Clean an offboarded sub-account in the Cleanup tab."}
          </p>
        )}

        {/* Say why the others can't be used, so nobody grabs one anyway. */}
        {poolInfo && poolInfo.notReady.length > 0 && (
          <details className="mt-2">
            <summary className="text-[11px] text-[#697a91] cursor-pointer">
              {poolInfo.counts.notReady} more in the pool, not ready yet
            </summary>
            <div className="mt-1.5 space-y-0.5">
              {poolInfo.notReady.slice(0, 12).map((p) => (
                <p key={p.pool_name} className="text-[11px] text-[#697a91]">
                  <b className="text-[#c2410c]">{p.pool_name}</b> — {p.blocker}
                </p>
              ))}
              {poolInfo.notReady.length > 12 && (
                <p className="text-[11px] text-[#9aa8bc]">…and {poolInfo.notReady.length - 12} more</p>
              )}
            </div>
          </details>
        )}
      </div>

      {/* Admin only: wipe offboarded sub-accounts into the pool. The team
          sees the counts above; only the admin gets the tools (and the API
          refuses everyone else). */}
      {role === "admin" && (
        <details id="cleanup" open={cleanupOpen} onToggle={(e) => setCleanupOpen((e.target as HTMLDetailsElement).open)}
          className="max-w-5xl mx-auto mb-4 rounded-xl border border-[#e2e8f0] bg-white">
          <summary className="cursor-pointer select-none px-4 py-3 flex items-center gap-2 text-sm font-semibold text-[#1e2b3d]">
            🧹 Clean accounts into the pool
            <span className="text-[10px] font-bold px-1.5 py-px rounded bg-[#eef2ff] text-[#3a5a8c] border border-[#c7d2fe]">ADMIN ONLY</span>
          </summary>
          {cleanupOpen && (
            <div className="px-4 pb-4 border-t border-[#eef3f8] pt-4">
              <CleanupPanel onPoolChanged={refreshPoolAfterClean} />
            </div>
          )}
        </details>
      )}

      {/* Owner 10/22/2026: onboarding on top (a client picker, not every card),
          the setup check below it — one column, not side by side. */}
      <div className="max-w-5xl mx-auto space-y-5">
      {SHOW_ONBOARDING_LIST && (
      <div className="rounded-xl border border-[#e2e8f0] bg-white p-4 space-y-4 min-w-0">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-[#1f3559]">Client Onboarding</h1>
          <p className="text-sm text-[#697a91]">Every setup step with its how-to video — tick them one by one per client</p>
        </div>
        <button onClick={() => setShowForm((s) => !s)}
          className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-[#15B7AE] hover:bg-[#0e8f88] text-white">
          <Plus size={14} /> New Client
        </button>
      </div>

      {showForm && (
        <div className="rounded-xl border border-[#a7e3df] bg-[#f7fdfc] p-4 space-y-3">
          <h2 className="text-sm font-bold text-[#1f3559]">New client details</h2>
          {formSections().map((sec, si) => (
          <div key={si} className={cn("pt-3", si > 0 && "border-t border-[#dcefed]")}>
            {sec.heading && <p className="text-xs font-bold text-[#34568a] uppercase tracking-wide mb-2">{sec.heading}</p>}
            <div className={cn("grid grid-cols-1 gap-3", sec.fields.every((x) => x.image) && sec.fields.length > 1 ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
            {sec.fields.map((f) => (
              <div key={f.key} className={cn(f.long && "sm:col-span-2")}>
                <label className="block text-[11px] font-medium text-[#697a91] mb-0.5">{f.label}{f.required && <span className="text-[#e11d48]"> *</span>}</label>
                {f.image ? (
                  <ImageField value={form[f.key] ?? ""} onChange={(url) => setForm((v) => ({ ...v, [f.key]: url }))} />
                ) : f.key === "version" ? (
                  <div className="flex gap-2">
                    {VERSION_PILLS.map((p) => (
                      <button key={p.value} type="button" onClick={() => setForm((v) => ({ ...v, version: p.value }))}
                        className={cn("px-4 py-2 rounded-lg text-sm font-bold border transition-colors", form.version === p.value ? p.on : p.off)}>
                        {p.label}
                      </button>
                    ))}
                  </div>
                ) : f.key === "services" ? (
                  <div className="flex flex-wrap gap-1.5">
                    {SERVICE_OPTIONS.map((s) => {
                      const selected = (form.services ?? "").split(",").map((x) => x.trim()).filter(Boolean);
                      const on = selected.includes(s);
                      return (
                        <button key={s} type="button"
                          onClick={() => setForm((v) => {
                            const cur = (v.services ?? "").split(",").map((x) => x.trim()).filter(Boolean);
                            const next = on ? cur.filter((x) => x !== s) : [...cur, s];
                            return { ...v, services: next.join(", ") };
                          })}
                          className={cn("px-2.5 py-1.5 rounded-full text-xs font-semibold border transition-colors",
                            on ? "bg-[#15B7AE] border-[#15B7AE] text-white" : "border-[#d7e0ea] text-[#34568a] hover:border-[#15B7AE] hover:text-[#0e8f88]")}>
                          {s}
                        </button>
                      );
                    })}
                  </div>
                ) : f.key === "offer" ? (
                  <select value={form.offer ?? ""} onChange={(e) => setForm((v) => ({ ...v, offer: e.target.value }))}
                    className="w-full px-3 py-2 bg-white border border-[#d7e0ea] rounded-lg text-sm text-[#1f3559] focus:outline-none focus:border-[#15B7AE]">
                    <option value="">Select…</option>
                    {OFFER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : f.long ? (
                  <textarea rows={2} value={form[f.key] ?? ""} onChange={(e) => setForm((v) => ({ ...v, [f.key]: e.target.value }))}
                    className="w-full px-3 py-2 bg-white border border-[#d7e0ea] rounded-lg text-sm text-[#1f3559] focus:outline-none focus:border-[#15B7AE] resize-y" />
                ) : (
                  <input type="text" value={form[f.key] ?? ""} onChange={(e) => setForm((v) => ({ ...v, [f.key]: e.target.value }))}
                    className="w-full px-3 py-2 bg-white border border-[#d7e0ea] rounded-lg text-sm text-[#1f3559] focus:outline-none focus:border-[#15B7AE]" />
                )}
              </div>
            ))}
            </div>
          </div>
          ))}
          <div className="flex items-center gap-2">
            <button onClick={create} disabled={creating || !String(form.business_name ?? "").trim() || !String(form.owner_name ?? "").trim() || !String(form.version ?? "").trim()}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-[#15B7AE] hover:bg-[#0e8f88] text-white disabled:opacity-50">
              {creating ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Start Onboarding
            </button>
            <button onClick={() => setShowForm(false)} className="px-3 py-2 text-xs font-semibold rounded-lg text-[#697a91] hover:bg-[#f1f5f9]">Cancel</button>
          </div>
        </div>
      )}

      {error ? (
        <div className="px-4 py-3 rounded-lg border border-[#f5c2cf] bg-[#fde8ee] text-[#e11d48] text-sm"><strong>Error:</strong> {error}</div>
      ) : loading ? (
        <div className="flex items-center gap-2 text-sm text-[#697a91] py-12 justify-center"><Loader2 size={15} className="animate-spin" /> Loading…</div>
      ) : list.length === 0 ? (
        <div className="py-12 text-center text-[#8595a8]">No onboardings yet — click <strong>New Client</strong> to start one.</div>
      ) : (
        <div className="space-y-2">
          {(() => {
            const label = (o: Onboarding) => {
              const st = o.status === "done" ? "complete" : o.setup?.status === "failed" ? "setup failed" : o.setup?.status === "waiting" ? "needs you" : o.setup?.status === "done" ? "setup done" : o.setup?.status ? "setup running" : "not started";
              return `${o.form.business_name}${o.form.owner_name ? ` · ${o.form.owner_name}` : ""} — ${progress(o).pct}% · ${st}`;
            };
            const active = list.filter((o) => o.status !== "done" && progress(o).pct < 100);
            const finished = list.filter((o) => !active.includes(o));
            return (
              <>
                <label className="block text-[11px] font-semibold text-[#697a91]">Open a client&apos;s setup</label>
                <select value="" onChange={(e) => { if (e.target.value) setOpenId(e.target.value); }}
                  className="w-full px-3 py-2.5 bg-white border border-[#d7e0ea] rounded-lg text-sm text-[#1f3559] focus:outline-none focus:border-[#15B7AE]">
                  <option value="">Pick a client… ({active.length} in setup{finished.length ? `, ${finished.length} finished` : ""})</option>
                  {active.length > 0 && <optgroup label={`🧩 In setup (${active.length})`}>{active.map((o) => <option key={o.id} value={o.id}>{label(o)}</option>)}</optgroup>}
                  {finished.length > 0 && <optgroup label={`✅ Finished (${finished.length})`}>{finished.map((o) => <option key={o.id} value={o.id}>{label(o)}</option>)}</optgroup>}
                </select>
                {active.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {active.map((o) => {
                      const pct = progress(o).pct;
                      const bad = o.setup?.status === "failed" || o.setup?.status === "waiting";
                      return (
                        <button key={o.id} onClick={() => setOpenId(o.id)} title={label(o)}
                          className={cn("flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-semibold transition-colors hover:border-[#15B7AE]",
                            bad ? "border-[#f5c2cf] bg-[#fff5f7] text-[#be123c]" : "border-[#d7e0ea] bg-[#f8fafc] text-[#1f3559]")}>
                          {o.form.business_name} <span className="text-[#0e8f88]">{pct}%</span>{bad && <span>⚠</span>}
                          <ChevronRight size={12} className="text-[#94a3b8]" />
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}
      </div>
      )}{/* /onboarding */}

      </div>{/* /stack */}
    </div>
  );
}
