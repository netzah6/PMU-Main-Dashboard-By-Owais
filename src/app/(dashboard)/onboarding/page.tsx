"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, ChevronLeft, ChevronRight, Trash2, ExternalLink, Check } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { ONBOARDING_STEPS, SECTION_ORDER, FORM_FIELDS, OFFER_OPTIONS, SERVICE_OPTIONS, formSections, type OnboardingStep } from "@/lib/onboarding-steps";

// Same version colors as the Clients tab: V3 solid blue, V2.3 light purple.
const VERSION_PILLS: { value: string; label: string; on: string; off: string }[] = [
  { value: "(V3)", label: "V3", on: "bg-[#1d4ed8] border-[#1d4ed8] text-white", off: "border-[#93c5fd] text-[#1d4ed8] hover:bg-[#eff6ff]" },
  { value: "(V2.3)", label: "V2.3", on: "bg-[#f3e8ff] border-[#e3cffb] text-[#7e22ce]", off: "border-[#e3cffb] text-[#7e22ce] hover:bg-[#faf5ff]" },
];
const verBadge = (v: string) =>
  v.toLowerCase().includes("v2.3") ? "bg-[#f3e8ff] text-[#7e22ce]" : v.toLowerCase().includes("v3") ? "bg-[#1d4ed8] text-white" : "bg-[#eef2ff] text-[#4f46e5]";

// Mirrors src/lib/ghl-claim.ts (server) — funnel URL convention.
const FUNNEL_DOMAIN = "https://pmu-care.com";
const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const FUNNEL_STEPS: { label: string; suffix: string }[] = [
  { label: "📝 Survey", suffix: "-survey" },
  { label: "📅 Booking", suffix: "-booking" },
  { label: "💰 Deposit", suffix: "-last-step" },
  { label: "🎉 Thank You", suffix: "-thank-you" },
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
}

function stepsFor(o: Onboarding): OnboardingStep[] {
  const isV3 = String(o.form.version ?? "").toLowerCase().includes("v3") && !String(o.form.version ?? "").toLowerCase().includes("v2.3");
  return ONBOARDING_STEPS.filter((s) => !s.v3Only || isV3);
}
function progress(o: Onboarding): { done: number; total: number } {
  const steps = stepsFor(o).filter((s) => s.section !== "Later");
  return { done: steps.filter((s) => o.checklist[s.key]?.done).length, total: steps.length };
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

  // Right-side "Check Setup" panel: verify any client by name or sub-account id.
  const [checkQuery, setCheckQuery] = useState("");
  const [checkRunning, setCheckRunning] = useState(false);
  const [checkResult, setCheckResult] = useState<{ business: string; query?: string; ranAt: string; depositUrl: string | null; funnelUrls?: { survey: string; booking: string; lastStep: string; thankYou: string } | null; productId?: string | null; checkoutUrl?: string | null; usersInfo?: { name: string; role: string; permissions: string[] }[]; checks: { key: string; status: string; detail: string }[] } | null>(null);
  const runCheck = useCallback(async (query: string) => {
    if (!query.trim()) return;
    setCheckRunning(true); setCheckResult(null);
    try {
      const res = await fetch("/api/onboarding/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Check failed");
      setCheckResult(json);
    } catch (e) { toast.error(`${e}`.replace("Error: ", "")); }
    finally { setCheckRunning(false); }
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch("/api/onboarding");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setList(json.onboardings ?? []);
    } catch (e) {
      setError(`${e}`.replace("Error: ", ""));
    } finally {
      setLoading(false);
    }
  }, []);
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
  const claim = useCallback(async (o: Onboarding) => {
    if (!window.confirm(`Claim a "Clean New Account" from the pool and rename it to "${o.form.business_name}"?\n\nThis renames the sub-account in GHL and fills its custom values from the form.`)) return;
    setClaiming(true);
    try {
      const res = await fetch(`/api/onboarding/${o.id}/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Claim failed");
      setList((l) => l.map((x) => (x.id === o.id ? json.onboarding : x)));
      toast.success(`Claimed ${json.claim.original_name} → ${json.claim.business_name} 🎉`);
    } catch (e) {
      toast.error(`${e}`.replace("Error: ", ""));
    } finally {
      setClaiming(false);
    }
  }, []);
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
    const pct = pr.total ? Math.round((pr.done / pr.total) * 100) : 0;
    return (
      <div className="p-4 sm:p-6 space-y-4 max-w-4xl">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <button onClick={() => setOpenId(null)} className="flex items-center gap-1 text-xs text-[#0e8f88] hover:underline mb-1">
              <ChevronLeft size={13} /> All onboardings
            </button>
            <h1 className="text-xl font-bold text-[#1f3559] truncate">{open.form.business_name}</h1>
            <p className="text-sm text-[#697a91]">{open.form.owner_name} · {open.form.version || "—"} · started {new Date(open.created_at).toLocaleDateString()}{open.created_by ? ` by ${open.created_by.split("@")[0]}` : ""}</p>
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
                <span className="text-[#8595a8] font-normal">· {manual} manual · {new Date(verifiedAt).toLocaleTimeString()}</span>
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

        {/* GHL account (pool claim) */}
        <div className="rounded-xl border border-[#e4ebf2] bg-white p-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-[#1f3559]">GHL Account</h2>
              {open.claim ? (
                <p className="text-xs text-[#697a91] mt-0.5">
                  <span className="font-semibold text-[#15803d]">✓ Claimed</span> — {open.claim.original_name} → <strong>{open.claim.business_name}</strong>
                  {" · "}{new Date(open.claim.claimed_at).toLocaleString()} by {open.claim.claimed_by.split("@")[0]}
                  {" · "}
                  <a href={`https://app.gohighlevel.com/location/${open.claim.location_id}`} target="_blank" rel="noopener noreferrer" className="text-[#0e8f88] hover:underline">open in GHL ↗</a>
                </p>
              ) : (
                <p className="text-xs text-[#697a91] mt-0.5">Take a pre-approved &quot;Clean New Account&quot; from the pool: rename it + fill custom values from the form. Data access is automatic (app pre-installed).</p>
              )}
            </div>
            {open.claim ? (
              <button onClick={() => unclaim(open)} disabled={claiming}
                className="shrink-0 px-3 py-1.5 text-xs font-semibold rounded-lg border border-[#f5c2cf] text-[#e11d48] hover:bg-[#fde8ee] disabled:opacity-50">
                {claiming ? <Loader2 size={13} className="animate-spin inline" /> : "Un-claim (return to pool)"}
              </button>
            ) : (
              <button onClick={() => claim(open)} disabled={claiming}
                className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#4f46e5] hover:bg-[#4338ca] text-white disabled:opacity-50">
                {claiming ? <Loader2 size={13} className="animate-spin" /> : "🚀"} Claim GHL Account
              </button>
            )}
          </div>
          {open.claim && open.claim.actions?.length > 0 && (
            <ul className="mt-2 space-y-1 border-t border-[#f1f5f9] pt-2">
              {open.claim.actions.map((a, i) => (
                <li key={i} className="text-xs flex items-start gap-1.5">
                  <span className={a.ok ? "text-[#15803d]" : "text-[#e11d48]"}>{a.ok ? "✓" : "✗"}</span>
                  <span className={a.ok ? "text-[#34568a]" : "text-[#e11d48] font-semibold"}>{a.action}{a.detail ? <span className={a.ok ? "text-[#8595a8]" : "text-[#e11d48]"}> — {a.detail}</span> : null}</span>
                </li>
              ))}
            </ul>
          )}
          {open.claim && (() => {
            const MANUAL: { key: string; label: string }[] = [
              { key: "ghl_domain", label: "Connect pmu-care.com to the sub-account" },
              { key: "funnel_path", label: "Set the 4 funnel paths (copy them from the Funnel paths box below)" },
              { key: "ghl_pixel", label: "Add the FB pixel to the funnel's Head Tracking Code" },
              { key: "user_add", label: "Create the employee user (API blocked by GHL plan)" },
            ];
            const left = MANUAL.filter((s) => !open.checklist[s.key]?.done);
            if (!left.length) return null;
            return (
              <div className="mt-2 border-t border-[#f1f5f9] pt-2">
                <p className="text-[10px] font-bold uppercase tracking-wide text-[#e11d48] mb-1">🔴 Still manual — do these in GHL:</p>
                <ul className="space-y-0.5">
                  {left.map((s) => (
                    <li key={s.key} className="text-xs text-[#e11d48] flex items-start gap-1.5">
                      <span>•</span><span>{s.label}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-[10px] text-[#8595a8] mt-1">Each disappears when its checklist step below is checked off.</p>
              </div>
            );
          })()}
        </div>

        {/* Funnel paths (generated from the business name) */}
        {String(open.form.business_name ?? "").trim() && (
          <div className="rounded-xl border border-[#e4ebf2] bg-white p-4">
            <h2 className="text-sm font-bold text-[#1f3559]">Funnel paths</h2>
            <p className="text-xs text-[#697a91] mt-0.5 mb-2">Paste each path into the matching step of &quot;CC - PMU Survey + Auto Booking (V2 / V3)&quot; (domain: pmu-care.com)</p>
            <ul className="space-y-1.5">
              {FUNNEL_STEPS.map((s) => {
                const path = `${slugify(open.form.business_name)}${s.suffix}`;
                return (
                  <li key={s.suffix} className="flex items-center gap-2 text-xs">
                    <span className="w-24 shrink-0 text-[#697a91]">{s.label}</span>
                    <code className="px-2 py-1 rounded bg-[#f8fafc] border border-[#eef3f8] text-[#1f3559] truncate">/{path}</code>
                    <button
                      onClick={() => { navigator.clipboard.writeText(path); toast.success(`Copied: ${path}`); }}
                      className="shrink-0 px-2 py-1 rounded-md text-[10px] font-semibold text-[#0e8f88] border border-[#a7e3df] hover:bg-[#f7fdfc]">
                      Copy
                    </button>
                    <a href={`${FUNNEL_DOMAIN}/${path}`} target="_blank" rel="noopener noreferrer" className="shrink-0 text-[10px] text-[#8595a8] hover:text-[#0e8f88] hover:underline">open ↗</a>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Client details */}
        <details className="rounded-xl border border-[#e4ebf2] bg-white">
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
                        {state?.done && <p className="text-[10px] text-[#a6b3c4]">✓ {state.by.split("@")[0]} · {new Date(state.at).toLocaleDateString()}</p>}
                      </div>
                      {s.loom && (
                        <a href={s.loom} target="_blank" rel="noopener noreferrer" title="Watch the how-to video"
                          className="shrink-0 flex items-center gap-1 text-[11px] font-semibold text-[#0e8f88] hover:underline">
                          <ExternalLink size={11} /> Loom
                        </a>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    );
  }

  // ── List + create form (left) · Check Setup (right) ──────────────────────
  return (
    <div className="p-4 sm:p-6">
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(360px,540px)_minmax(0,1fr)] gap-5 items-start">
      {/* LEFT — onboarding */}
      <div className="space-y-4 min-w-0">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-[#1f3559]">Client Onboarding</h1>
          <p className="text-sm text-[#697a91]">New-client setup checklist · replaces the onboarding spreadsheet</p>
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
          {list.map((o) => {
            const pr = progress(o);
            const pct = pr.total ? Math.round((pr.done / pr.total) * 100) : 0;
            return (
              <button key={o.id} onClick={() => setOpenId(o.id)}
                className="w-full text-left rounded-xl border border-[#e4ebf2] bg-white p-3.5 hover:border-[#15B7AE] transition-colors">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-[#1f3559] truncate">{o.form.business_name}</span>
                      <span className="text-xs text-[#697a91]">{o.form.owner_name}</span>
                      {o.form.version && <span className={cn("px-1.5 py-0.5 rounded text-[9px] font-bold", verBadge(o.form.version))}>{o.form.version}</span>}
                      {o.status === "done" && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-[#e6f7ee] text-[#15803d]">✓ COMPLETE</span>}
                    </div>
                    <p className="text-[11px] text-[#8595a8] mt-0.5">Started {new Date(o.created_at).toLocaleDateString()}{o.created_by ? ` by ${o.created_by.split("@")[0]}` : ""}</p>
                  </div>
                  <div className="shrink-0 flex items-center gap-3">
                    <div className="w-28 hidden sm:block">
                      <div className="h-2 rounded-full bg-[#f1f5f9] overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: pct === 100 ? "#15803d" : "#15B7AE" }} />
                      </div>
                    </div>
                    <span className={cn("text-sm font-bold", pct === 100 ? "text-[#15803d]" : "text-[#0e8f88]")}>{pct}%</span>
                    <ChevronRight size={16} className="text-[#94a3b8]" />
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
      </div>{/* /LEFT */}

      {/* RIGHT — Check Setup */}
      <div className="lg:sticky lg:top-4">
        <CheckPanel query={checkQuery} setQuery={setCheckQuery} running={checkRunning} result={checkResult} onRun={runCheck} businesses={list.map((o) => o.form.business_name).filter(Boolean)} />
      </div>
      </div>{/* /grid */}
    </div>
  );
}

// ── Check Setup panel: verify any client by name or sub-account id ────────────
function CheckPanel({ query, setQuery, running, result, onRun, businesses }: {
  query: string; setQuery: (s: string) => void; running: boolean;
  result: { business: string; query?: string; ranAt: string; depositUrl: string | null; funnelUrls?: { survey: string; booking: string; lastStep: string; thankYou: string } | null; productId?: string | null; checkoutUrl?: string | null; usersInfo?: { name: string; role: string; permissions: string[] }[]; checks: { key: string; status: string; detail: string }[] } | null;
  onRun: (q: string) => void; businesses: string[];
}) {
  const byKey = new Map((result?.checks ?? []).map((c) => [c.key, c]));
  const all = result?.checks ?? [];
  const nPass = all.filter((c) => c.status === "pass").length;
  const nFail = all.filter((c) => c.status === "fail").length;
  const nManual = all.filter((c) => c.status === "manual").length;
  return (
    <div className="rounded-xl border border-[#c9dbfb] bg-[#f7faff] p-4 space-y-3">
      <div>
        <h2 className="text-sm font-bold text-[#1f3559]">🤖 Check a client&apos;s setup</h2>
        <p className="text-[11px] text-[#697a91] mt-0.5">Enter a business/client name or a sub-account ID — get a checkmark report of what&apos;s set up right and what needs fixing.</p>
      </div>
      <div className="space-y-2">
        <input list="ob-biz-list" value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onRun(query)}
          placeholder="Business name or sub-account ID" className="w-full px-3 py-2 bg-white border border-[#c9dbfb] rounded-lg text-sm text-[#1f3559] focus:outline-none focus:border-[#4f46e5]" />
        <datalist id="ob-biz-list">{businesses.map((b) => <option key={b} value={b} />)}</datalist>
        <button onClick={() => onRun(query)} disabled={running || !query.trim()}
          className="w-full flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-[#4f46e5] hover:bg-[#4338ca] text-white disabled:opacity-50">
          {running ? <Loader2 size={14} className="animate-spin" /> : "🤖"} Run check
        </button>
      </div>

      {running && <div className="flex items-center gap-2 text-xs text-[#697a91] py-6 justify-center"><Loader2 size={14} className="animate-spin" /> Checking the live setup…</div>}

      {result && !running && (
        <div className="space-y-2.5">
          <div className={cn("rounded-lg border px-3 py-2", nFail ? "border-[#fcd9a8] bg-[#fffdf7]" : "border-[#86efac] bg-[#f0fdf4]")}>
            <div className="text-[13px] font-bold text-[#1f3559] truncate">{result.business || result.query}</div>
            <div className="text-[11px]">
              <span className="text-[#15803d] font-semibold">✓ {nPass}</span>
              {nFail > 0 && <span className="text-[#c2410c] font-semibold"> · ✗ {nFail} to fix</span>}
              <span className="text-[#8595a8]"> · {nManual} manual</span>
            </div>
          </div>

          {/* Live funnel previews — visual proof each page renders correctly */}
          {result.funnelUrls && (
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wide text-[#8595a8] px-0.5 mb-1">Funnel previews (live)</div>
              <div className="grid grid-cols-2 xl:grid-cols-4 gap-1.5">
                {([["📝 Survey", result.funnelUrls.survey], ["📅 Booking", result.funnelUrls.booking], ["💰 Deposit", result.funnelUrls.lastStep], ["🎉 Thank You", result.funnelUrls.thankYou]] as const).map(([label, url]) => (
                  <div key={label} className="rounded-lg border border-[#e4ebf2] overflow-hidden bg-white">
                    <a href={url} target="_blank" rel="noopener noreferrer" title={url} className="block relative h-[110px] overflow-hidden group">
                      <iframe src={url} title={label} loading="lazy" tabIndex={-1}
                        className="absolute top-0 left-0 border-0 pointer-events-none"
                        style={{ width: "390px", height: "620px", transform: "scale(0.44)", transformOrigin: "top left" }} />
                      <span className="absolute inset-0 group-hover:bg-black/5" />
                    </a>
                    <a href={url} target="_blank" rel="noopener noreferrer" className="block px-1.5 py-1 text-[10px] font-semibold text-[#0e8f88] hover:underline truncate border-t border-[#f1f5f9]">{label} ↗</a>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-[#8595a8] mt-1">Live pages — click any to open full-size and eyeball the layout, pictures, map &amp; checkout.</p>
            </div>
          )}

          {/* Full checklist grouped by section, 2 columns so it fits without scrolling */}
          <div className="sm:columns-2 xl:columns-3 2xl:columns-4 gap-x-4">
            {SECTION_ORDER.map((section) => {
              const secSteps = ONBOARDING_STEPS.filter((s) => s.section === section && byKey.has(s.key));
              if (!secSteps.length) return null;
              return (
                <div key={section} className="break-inside-avoid mb-2.5">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-[#8595a8] px-0.5 mb-0.5">{section}</div>
                  <ul className="space-y-0.5">
                    {secSteps.map((s) => {
                      const c = byKey.get(s.key)!;
                      const icon = c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : "○";
                      const color = c.status === "pass" ? "text-[#15803d]" : c.status === "fail" ? "text-[#e11d48]" : "text-[#b9c3d0]";
                      // Show the product ID + checkout link right under the "create product" row.
                      const showProduct = s.key === "fanbasis_product" && result.productId;
                      // Checks whose detail is a useful breakdown even when passing
                      // (e.g. AREA options vs services, user list, assign evidence).
                      const showPassDetail = c.status === "pass" && ["wf_area", "user_add", "wf_assign", "user_permissions", "user_phone", "cal_availability", "fin_test", "make_filter", "make_http"].includes(s.key);
                      // "Screenshot" equivalents: expandable permissions list and a
                      // live booking-page view (scroll inside it to eyeball the IG widget).
                      const showPerms = s.key === "user_permissions" && (result.usersInfo?.length ?? 0) > 0;
                      const showIgPreview = s.key === "funnel_ig_widget" && !!result.funnelUrls?.booking;
                      return (
                        <li key={s.key} className="flex items-start gap-1.5">
                          <span className={cn("text-[13px] leading-tight mt-px shrink-0", color)}>{icon}</span>
                          <div className="min-w-0">
                            <span className={cn("text-[12px]", c.status === "manual" ? "text-[#8595a8]" : "text-[#34568a]")} title={c.detail}>{s.label}</span>
                            {c.status === "fail" && <div className="text-[10px] text-[#c2410c]">{c.detail}</div>}
                            {showPassDetail && <div className="text-[10px] text-[#697a91]">{c.detail}</div>}
                            {showPerms && (
                              <details className="mt-0.5">
                                <summary className="text-[10px] text-[#0e8f88] cursor-pointer select-none">🔐 View permissions</summary>
                                <div className="mt-1 space-y-1.5">
                                  {result.usersInfo!.map((u) => (
                                    <div key={u.name}>
                                      <div className="text-[10px] font-semibold text-[#1f3559]">{u.name} — {u.role} · {u.permissions.length} permissions</div>
                                      <div className="flex flex-wrap gap-0.5 mt-0.5">
                                        {u.permissions.map((p) => (
                                          <code key={p} className="text-[8px] leading-tight px-1 py-px rounded bg-[#eef2f7] text-[#34568a]">{p}</code>
                                        ))}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </details>
                            )}
                            {showIgPreview && (
                              <details className="mt-0.5">
                                <summary className="text-[10px] text-[#0e8f88] cursor-pointer select-none">📸 View booking page (scroll to the IG widget)</summary>
                                <iframe src={result.funnelUrls!.booking} title="Booking page — Instagram widget" className="mt-1 w-full h-80 rounded-md border border-[#dbe3ec] bg-white" />
                              </details>
                            )}
                            {showProduct && (
                              <div className="text-[10px] mt-0.5 leading-snug">
                                <div className="text-[#697a91]">Product ID: <code className="font-semibold text-[#1f3559]">{result.productId}</code></div>
                                {result.checkoutUrl
                                  ? <a href={result.checkoutUrl} target="_blank" rel="noopener noreferrer" className="text-[#0e8f88] hover:underline break-all">{result.checkoutUrl} ↗</a>
                                  : <span className="text-[#8595a8]">Fanbasis checkout link unavailable</span>}
                              </div>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
          <p className="text-[10px] text-[#8595a8] pt-0.5">○ = verify manually (external tools — Facebook, Make.com, CloseBot, phone/A2P, forms, calendar).</p>
        </div>
      )}

      {!result && !running && (
        <p className="text-[11px] text-[#8595a8] text-center py-4">Auto-checks the funnel, PRODUCT ID, redirect, map, pixel &amp; sheets; lists every other step to verify by hand.</p>
      )}
    </div>
  );
}
