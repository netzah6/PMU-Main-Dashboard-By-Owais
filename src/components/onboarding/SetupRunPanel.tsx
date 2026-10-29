"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, RefreshCw, Check, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { MINI_REFRESH_EVENT } from "@/components/agent/MacMiniTracker";
import ScreenshotGallery from "@/components/agent/ScreenshotGallery";
import { StepVideos, useStepVideos } from "@/components/onboarding/StepVideos";
import { RUNBOOK, RUNBOOK_SECTIONS, WHO_LABEL, missingFields, requiredFields, PREAPPROVABLE, type RunbookStep, type SetupState, type StepState, type Who } from "@/lib/setup-runbook";

/* The New Client Setup run on an Onboarding card.
   Before Approve: which clean account it will take (dropdown), the step-by-step
   plan with who does each, and the Approve button. Nothing touches GHL
   before that click.
   After: a banner (running / needs you / done / failed), every step with
   its tick, who did it, when (US dates), the AI Agent's screenshots, Retry
   / Skip on a failed step, and the final summary text. */

type Card = { status: string; screenshots: Array<{ name: string; url: string }>; result: string | null };
type Pool = { choices: Array<{ id: string; name: string; readiness: string; blocker: string | null }>; defaultId: string | null; note?: string };
type Setup = Omit<SetupState, "password"> & { has_password: boolean };
type SharedPixel = { id: string; clients: number; sample: string[] };
type Data = { setup: Setup | null; cards: Record<string, Card>; pool: Pool | null; pixels?: SharedPixel[]; claimedLocation: string | null; canApprove: boolean; autofilled?: string[] };
const NO_PIXEL_RE = /^(later|none|no|n\/a|skip|not yet|no pixel)/i;

// Steps the AI Agent does by itself (the dashboard's API steps count too — to
// a coach both are "done for you"); the rest are done by hand.
const AGENT: Who[] = ["api", "mini", "ask"];
const WHO_STYLE: Record<Who, string> = {
  api: "bg-[#e6edfb] text-[#2f5fb8]", mini: "bg-[#e6edfb] text-[#2f5fb8]", ask: "bg-[#e6edfb] text-[#2f5fb8]",
  owner: "bg-[#fff1df] text-[#b35a00]", team: "bg-[#ece9fb] text-[#6b5bd1]", client: "bg-[#eceff3] text-[#6b7280]",
};
const usWhen = (iso?: string) => (iso ? new Date(iso).toLocaleString("en-US", { month: "2-digit", day: "2-digit", year: "numeric", hour: "numeric", minute: "2-digit" }) : "");

function stepIcon(st: StepState, card?: Card): { icon: string; cls: string; label: string } {
  const live = card?.status;
  if (st.status === "queued" || st.status === "waiting_owner" || st.status === "running") {
    if (live === "running") return { icon: "🤖", cls: "text-[#2f5fb8]", label: "AI Agent working…" };
    if (live === "queued_browser") return { icon: "⏳", cls: "text-[#b35a00]", label: "waiting for the AI Agent" };
    if (live === "pending" || st.status === "waiting_owner") return { icon: "✋", cls: "text-[#b35a00]", label: "needs your Approve (AI tab)" };
    if (live === "denied") return { icon: "✗", cls: "text-[#e11d48]", label: "denied in the AI tab — Retry to file it again" };
    if (st.status === "running") return { icon: "⟳", cls: "text-[#2f5fb8]", label: "dashboard working…" };
    return { icon: "⏳", cls: "text-[#b35a00]", label: "queued" };
  }
  switch (st.status) {
    case "done": return { icon: "✓", cls: "text-[#15803d]", label: "done" };
    case "warn": return { icon: "⚠", cls: "text-[#c2410c]", label: "done, look at this" };
    case "failed": return { icon: "✗", cls: "text-[#e11d48]", label: "failed" };
    case "skipped": return { icon: "↷", cls: "text-[#64748b]", label: "approved manually" };
    case "manual": return { icon: "○", cls: "text-[#8595a8]", label: "" };
    default: return { icon: "·", cls: "text-[#cbd5e1]", label: "" };
  }
}

export function SetupRunPanel({ onboardingId, role, form, onChanged }: {
  onboardingId: string; role: string | null; form: Record<string, string>;
  onChanged?: () => void; // the card's checklist moved — reload the card
}) {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [poolId, setPoolId] = useState<string>("");
  const [showPlan, setShowPlan] = useState(true);
  // Pre-flight (owner 10/20/2026): missing fields are filled right here, and
  // the "asks you" steps are approved up front so the run never waits.
  const [fill, setFill] = useState<Record<string, string>>({});
  const [savingFill, setSavingFill] = useState(false);
  const [preapproved, setPreapproved] = useState<string[]>(() => PREAPPROVABLE.map((p) => p.key));
  const saveFill = async () => {
    const patch = Object.fromEntries(Object.entries(fill).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
    if (!Object.keys(patch).length) return;
    setSavingFill(true);
    try {
      const r = await fetch(`/api/onboarding/${onboardingId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ form: patch }) });
      if (!r.ok) throw new Error((await r.json()).error || "Save failed");
      setFill({});
      toast.success("Saved to the card");
      onChanged?.();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Save failed"); }
    setSavingFill(false);
  };
  const [password, setPassword] = useState<string | null>(null);
  // The page's sub-headline slot for the account line (exists once the page has rendered).
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setSlot(document.getElementById("setup-meta-slot")); }, [onboardingId]);

  // The pool list costs a GHL call — never re-fetch it just because the
  // dropdown changed (poolId is read through a ref, not a dependency).
  const poolIdRef = useRef(poolId);
  poolIdRef.current = poolId;
  // The page passes a fresh arrow each render — keep it in a ref so load() stays stable.
  const onChangedRef = useRef(onChanged);
  useEffect(() => { onChangedRef.current = onChanged; }, [onChanged]);
  const load = useCallback(async (quiet = false) => {
    try {
      const r = await fetch(`/api/onboarding/${onboardingId}/setup`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load the setup run");
      setData(j); setErr(null);
      if (!poolIdRef.current && j.pool?.defaultId) setPoolId(j.pool.defaultId);
      // The server just filled fields from the Clients tab → refresh the card's form.
      if (Array.isArray(j.autofilled) && j.autofilled.length) { toast.success(`Filled from the Clients tab: ${j.autofilled.join(", ").replace(/_/g, " ")}`); onChangedRef.current?.(); }
    } catch (e) { if (!quiet) setErr(`${e}`.replace("Error: ", "")); }
  }, [onboardingId]);
  useEffect(() => { void load(); }, [load]);
  // While the run is open, poll — the Mac Mini ticks steps on its own.
  const active = data?.setup && (data.setup.status === "running" || data.setup.status === "waiting");
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => { void load(true); }, 20_000);
    return () => clearInterval(t);
  }, [active, load]);

  /* The message the team pastes to the client once the funnel test passed
     (owner 10/20/2026): funnel link + GoHighLevel login. The password is
     fetched for admins; everyone else gets the message without it. */
  const copyClientMessage = async () => {
    setBusy("copy");
    try {
      let pw: string | null = null;
      if (role === "admin") {
        const r = await fetch(`/api/onboarding/${onboardingId}/setup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "password" }) });
        const j = await r.json().catch(() => ({}));
        pw = j.password ?? null;
      }
      const first = String(form.owner_name ?? "").trim().split(/\s+/)[0] || "there";
      const funnel = data?.setup?.funnel_url ?? "";
      const lines = [
        `Hey ${first}! 🎉`,
        "",
        `I'm excited to share that your ${form.business_name} account is ready to go.`,
        "",
        "Here are your logins for the booking system:",
        "Login page: https://app.pmu-bookings.com/",
        form.email ? `Email: ${form.email}` : "",
        pw ? `Password: ${pw}` : role === "admin" ? "Password: (not set yet)" : "Password: (ask the admin)",
        "",
        "On your phone, download the \"Lead Connector\" app (see the picture) and log in with the same email and password:",
        "iPhone: https://apps.apple.com/us/app/lead-connector/id1564302502",
        "Android: https://play.google.com/store/apps/details?id=com.LeadConnector",
        "",
        funnel ? `And here is the funnel we built for you — this is the page your ads will send clients to:\n${funnel}` : "",
        "",
        "Could you try logging in and let me know it works on your end? If you have any questions at all, just reply here — I'm happy to help.",
        "",
        "Welcome aboard!",
      ];
      await navigator.clipboard.writeText(lines.filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n").trim());
      toast.success("Message copied — paste it to the client with the app picture, then mark the step completed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not copy");
    }
    setBusy(null);
  };

  /* The "download the Lead Connector app" picture that goes with the message. */
  const copyAppPicture = async () => {
    setBusy("picture");
    try {
      const blob = await fetch("/leadconnector-app.png").then((r) => r.blob());
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast.success("Picture copied — paste it into the text or email");
    } catch {
      window.open("/leadconnector-app.png", "_blank");
      toast("Opened the picture — save it and attach it to the message");
    }
    setBusy(null);
  };

  const act = useCallback(async (action: string, extra: Record<string, unknown> = {}, label = action) => {
    setBusy(label);
    try {
      const r = await fetch(`/api/onboarding/${onboardingId}/setup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...extra }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Failed");
      if (action === "password") { setPassword(j.password ?? "(not set yet)"); return; }
      setData((d) => (d ? { ...d, setup: j.setup } : d));
      await load(true);
      onChanged?.();
      window.dispatchEvent(new Event(MINI_REFRESH_EVENT)); // may have queued AI Agent work
      if (action === "approve") toast.success("Approved — the account steps are running");
      if (action === "retry") toast.success("Step queued again");
      if (action === "skip") toast.success(extra.note === "not needed" ? "Step marked not needed" : extra.note === "completed" ? "Step marked completed" : "Step approved manually");
      if (action === "confirm") toast.success("Approved — the dashboard is doing it now");
    } catch (e) { toast.error(`${e}`.replace("Error: ", "")); }
    finally { setBusy(null); }
  }, [onboardingId, load, onChanged]);

  const isAdmin = role === "admin";
  const setup = data?.setup ?? null;
  const steps = useMemo(() => RUNBOOK.filter((s) => !s.later), []);
  const counts = useMemo(() => {
    if (!setup) return null;
    const run = steps.filter((s) => ["api", "mini", "ask"].includes(s.who));
    const done = run.filter((s) => ["done", "warn", "skipped"].includes(setup.steps[s.key]?.status ?? "")).length;
    return { done, total: run.length };
  }, [setup, steps]);

  if (err) return <div className="rounded-xl border border-[#f5c2cf] bg-[#fde8ee] px-4 py-3 text-xs text-[#e11d48]">Setup run: {err}</div>;
  if (!data) return <div className="rounded-xl border border-[#e4ebf2] bg-white px-4 py-3 text-xs text-[#697a91] flex items-center gap-2"><Loader2 size={13} className="animate-spin" /> Loading the setup run…</div>;

  // ── Before Approve ───────────────────────────────────────────────────────
  if (!setup) {
    const pool = data.pool;
    const pick = pool?.choices.find((c) => c.id === poolId);
    const needs = missingFields(form);
    return (
      <div className="rounded-xl border border-[#c9dbfb] bg-[#f7faff] p-4 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-sm font-bold text-[#1f3559]">🧩 Set up this account</h2>
          </div>
          <button onClick={() => void load()} className="p-1.5 rounded text-[#8595a8] hover:text-[#0e8f88]" title="Refresh"><RefreshCw size={13} /></button>
        </div>

        {/* The clean account */}
        <div className="rounded-lg border border-[#c9dbfb] bg-white px-3 py-2.5">
          <div className="text-[10px] font-bold uppercase tracking-wide text-[#8595a8]">It will take</div>
          {data.claimedLocation ? (
            <p className="text-sm text-[#1f3559] mt-0.5">The account already claimed on this card (the Claim button) — the run continues on it.</p>
          ) : pool ? (
            <>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <select value={poolId} onChange={(e) => setPoolId(e.target.value)}
                  className="px-2.5 py-1.5 rounded-lg border border-[#c9dbfb] bg-white text-sm font-semibold text-[#1f3559]">
                  {pool.choices.length === 0 && <option value="">No A2P-approved clean account available</option>}
                  {pool.choices.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}{c.readiness === "ready" ? " · ready" : c.blocker ? ` · ${c.blocker}` : ""}</option>
                  ))}
                </select>
                {pick && (
                  <span className={cn("text-[11px] font-semibold px-2 py-0.5 rounded-full", pick.readiness === "ready" ? "bg-[#e4f5e9] text-[#1b7f3a]" : "bg-[#fff1df] text-[#b35a00]")}>
                    {pick.readiness === "ready" ? "snapshot loaded + A2P approved" : pick.blocker ?? pick.readiness}
                  </span>
                )}
              </div>
            </>
          ) : <p className="text-xs text-[#697a91]">Loading the pool…</p>}
        </div>

        {/* Pre-flight: what a {version} setup needs, filled in right here */}
        <div className={cn("rounded-lg border px-3 py-2.5", needs.length ? "border-[#fcd9a8] bg-[#fff7ec]" : "border-[#bfe3cd] bg-[#f3fbf6]")}>
          <div className="text-[10px] font-bold uppercase tracking-wide text-[#8595a8]">Before the run starts · {form.version || "version?"} setup</div>
          {needs.length ? (
            <>
              <p className="text-xs font-semibold text-[#b35a00] mt-0.5">⚠ {needs.length} of {requiredFields(form.version).length} required details missing — fill them here, then Approve.</p>
              <div className="mt-1.5 grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1.5">
                {needs.map((f) => (
                  <label key={f.key} className="text-[11px] text-[#1f3559]">
                    <span className="block text-[#697a91]">{f.label}</span>
                    {f.key === "version" ? (
                      <select value={fill.version ?? ""} onChange={(e) => setFill((v) => ({ ...v, version: e.target.value }))} className="mt-0.5 w-full px-2 py-1 rounded-md border border-[#d7e0ea] bg-white text-xs">
                        <option value="">Pick…</option><option value="V1">V1</option><option value="V2.3">V2.3</option><option value="V3">V3</option>
                      </select>
                    ) : f.key === "meta_pixel_id" ? (
                      <PixelPicker value={fill.meta_pixel_id ?? ""} pixels={data?.pixels ?? []} onChange={(meta_pixel_id) => setFill((v) => ({ ...v, meta_pixel_id }))} />
                    ) : (
                      <input value={fill[f.key] ?? ""} onChange={(e) => setFill((v) => ({ ...v, [f.key]: e.target.value }))} className="mt-0.5 w-full px-2 py-1 rounded-md border border-[#d7e0ea] bg-white text-xs" />
                    )}
                  </label>
                ))}
              </div>
              <button onClick={() => void saveFill()} disabled={savingFill || !Object.values(fill).some((v) => v.trim())}
                className="mt-2 px-2.5 py-1 rounded-md text-[11px] font-semibold bg-[#15B7AE] hover:bg-[#0e8f88] text-white disabled:opacity-50">
                {savingFill ? <Loader2 size={11} className="animate-spin inline" /> : "💾"} Save to the card
              </button>
            </>
          ) : (
            <p className="text-xs font-semibold text-[#15803d] mt-0.5">✓ All {requiredFields(form.version).length} required details are on the card.</p>
          )}
          {/* Approve the "asks you" steps now, so the AI Agent runs straight through */}
          <div className="mt-2 pt-2 border-t border-[#eadfc7]/60">
            {PREAPPROVABLE.map((p) => (
              <label key={p.key} className="flex items-start gap-1.5 text-[11px] text-[#1f3559] mt-0.5" title={p.label}>
                <input type="checkbox" checked={preapproved.includes(p.key)} onChange={(e) => setPreapproved((v) => (e.target.checked ? [...v, p.key] : v.filter((k) => k !== p.key)))} className="mt-0.5" />
                {p.key === "funnel_ig" ? (
                  <span>{p.title} — {String(form.ig_link ?? "").trim()
                    ? <a href={/^https?:/i.test(form.ig_link) ? form.ig_link : `https://instagram.com/${form.ig_link.replace(/^@/, "")}`} target="_blank" rel="noopener noreferrer" className="text-[#0e8f88] hover:underline">{form.ig_link} ↗</a>
                    : <span className="text-[#b35a00]">no Instagram link on the form — add it, or untick and the widget is skipped</span>}
                    <span className="text-[#8595a8]"> · check the page first (9+ posts, profile picture)</span></span>
                ) : (
                  <span>{p.title} <span className="text-[#8595a8]">— {p.label}</span></span>
                )}
              </label>
            ))}
          </div>
        </div>

        {/* The plan */}
        <div>
          <button onClick={() => setShowPlan((v) => !v)} className="text-[11px] text-[#0e8f88] hover:underline">{showPlan ? "hide" : "show"} the {RUNBOOK.length}-step plan</button>
          {showPlan && <PlanList steps={steps} setup={null} cards={{}} isAdmin={isAdmin} />}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {data.canApprove ? (
            <button onClick={() => { if (window.confirm(`Approve: take "${pick?.name ?? data.claimedLocation ?? "the claimed account"}" and set up ${form.business_name}?\n\nThe account steps run now; browser steps go to the AI Agent one by one.${preapproved.length ? ` Approved up front: ${PREAPPROVABLE.filter((p) => preapproved.includes(p.key)).map((p) => p.title).join(", ")}.` : ""}${PREAPPROVABLE.filter((p) => !preapproved.includes(p.key)).length ? ` Skipped: ${PREAPPROVABLE.filter((p) => !preapproved.includes(p.key)).map((p) => p.title).join(", ")}.` : ""} Nothing will stop to ask you.`)) void act("approve", { poolLocationId: poolId, preapproved }); }}
              disabled={!!busy || (!data.claimedLocation && !poolId) || needs.length > 0}
              title={needs.length ? "Fill the missing details first" : undefined}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#15803d] hover:bg-[#166534] text-white text-xs font-semibold disabled:opacity-50">
              {busy === "approve" ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} {busy === "approve" ? "Running the account steps… (1–3 min)" : "Approve & start"}
            </button>
          ) : <span className="text-xs text-[#8595a8]">Only an admin or a Client Success Coach can start the setup.</span>}
        </div>
      </div>
    );
  }

  // ── After Approve ────────────────────────────────────────────────────────
  const banner = setup.status === "done"
    ? { cls: "border-[#bfe3cd] bg-[#f3fbf6] text-[#15803d]", text: "✅ Setup done" }
    : setup.status === "failed"
      ? { cls: "border-[#f5c2cf] bg-[#fffafb] text-[#b91c1c]", text: "❌ Setup stopped on a failed step — Retry or Skip it below" }
      : setup.status === "waiting"
        ? { cls: "border-[#fcd9a8] bg-[#fff7ec] text-[#b35a00]", text: steps.some((s) => s.confirm && setup.steps[s.key]?.status !== "done" && setup.steps[s.key]?.status !== "skipped" && !setup.steps[s.key]?.confirmed_by && ["done", "warn", "skipped"].includes(setup.steps.funnel_test?.status ?? ""))
            ? "✅ The AI Agent is done — send the client the logins, then click Approve on \"Move to First Cycle\" below"
            : "✋ Waiting for you — approve the step in the AI tab" }
        : { cls: "border-[#c9dbfb] bg-[#f7faff] text-[#2f5fb8]", text: "⟳ Running — the dashboard and the AI Agent are working through the steps" };
  /* Owner 2026-10-20: no headline, no summary text. The account line sits in
     the page's sub-headline; here only the status, the funnel and the
     client's login. */
  const meta = (
    <span className="text-[#697a91]">
      {" · "}{setup.pool_name} → <b className="text-[#1f3559]">{form.business_name}</b>
      {" · "}<a href={`https://app.gohighlevel.com/v2/location/${setup.location_id}/dashboard`} target="_blank" rel="noopener noreferrer" className="text-[#0e8f88] hover:underline">open in GHL ↗</a>
      {setup.funnel_url && <> · <a href={setup.funnel_url} target="_blank" rel="noopener noreferrer" className="text-[#0e8f88] hover:underline">funnel ↗</a></>}
    </span>
  );
  return (
    <div className="rounded-xl border border-[#e4ebf2] bg-white p-4 space-y-3">
      {slot && createPortal(meta, slot)}
      <div className="flex items-center gap-2">
        <div className={cn("flex-1 min-w-0 rounded-lg border px-3 py-1.5 text-xs font-semibold", banner.cls)}>{banner.text}</div>
        {counts && <span className="text-xs font-semibold text-[#34568a] whitespace-nowrap">{counts.done}/{counts.total} run steps</span>}
        <button onClick={() => void act("refresh", {}, "refresh")} disabled={!!busy} title="Re-check and continue the run" className="p-1.5 rounded text-[#8595a8] hover:text-[#0e8f88] disabled:opacity-50">
          <RefreshCw size={13} className={busy === "refresh" ? "animate-spin" : ""} />
        </button>
      </div>

      {(setup.funnel_url || (setup.has_password && isAdmin)) && (
        <div className="flex items-center gap-x-4 gap-y-1 flex-wrap text-xs">
          {setup.funnel_url && (
            <span className="min-w-0 truncate"><span className="text-[#697a91]">Funnel: </span>
              <a href={setup.funnel_url} target="_blank" rel="noopener noreferrer" className="text-[#0e8f88] hover:underline">{setup.funnel_url.replace(/^https?:\/\//, "")}</a></span>
          )}
          {setup.has_password && isAdmin && (
            <span className="flex items-center gap-2">
              <span className="text-[#697a91]">Client login:</span>
              {form.email && <code className="px-2 py-0.5 rounded bg-[#f1f5f9] text-[#1f3559]">{form.email}</code>}
              {password ? <code className="px-2 py-0.5 rounded bg-[#f1f5f9] text-[#1f3559]">{password}</code> : <span className="text-[#8595a8]">••••••••</span>}
              <button onClick={() => (password ? setPassword(null) : void act("password", {}, "password"))} className="flex items-center gap-1 text-[#0e8f88] hover:underline">
                {busy === "password" ? <Loader2 size={12} className="animate-spin" /> : password ? <EyeOff size={12} /> : <Eye size={12} />} {password ? "hide" : "show"}
              </button>
            </span>
          )}
          {/* Owner 10/20/2026: the welcome text for the client, one click to copy. */}
          {setup.has_password && (
            <button onClick={() => void copyClientMessage()} disabled={!!busy} title="Copy the welcome message with the funnel link and login — paste it to the client"
              className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-[#4f46e5] hover:bg-[#4338ca] text-white disabled:opacity-50">
              {busy === "copy" ? <Loader2 size={11} className="animate-spin inline" /> : "📋"} Copy welcome message
            </button>
          )}
          {setup.has_password && (
            <button onClick={() => void copyAppPicture()} disabled={!!busy} title="Copy the Lead Connector app picture to send with the message"
              className="px-2.5 py-1 rounded-md text-[11px] font-semibold border border-[#c9dbfb] text-[#2f5fb8] hover:bg-[#f7faff] disabled:opacity-50">
              {busy === "picture" ? <Loader2 size={11} className="animate-spin inline" /> : "📱"} Copy app picture
            </button>
          )}
        </div>
      )}

      <PlanList steps={steps} setup={setup} cards={data.cards} onboardingId={onboardingId} isAdmin={isAdmin}
        actions={(s, st) => {
          const card = st.proposal_id ? data.cards[st.proposal_id] : undefined;
          const failed = st.status === "failed" || card?.status === "denied";
          const canRetry = isAdmin && (failed || st.status === "warn");
          const byHand = !AGENT.includes(s.who);
          // Team / owner / client steps are "manual" until someone marks them completed.
          const canSkip = (isAdmin || role === "editor") && (failed || st.status === "warn" || st.status === "todo" || st.status === "queued" || st.status === "waiting_owner" || (byHand && st.status === "manual"));
          const canConfirm = (isAdmin || role === "editor") && !!s.confirm && st.status === "todo" && !st.confirmed_by && ["done", "warn", "skipped"].includes(setup.steps.funnel_test?.status ?? "");
          const canCopy = s.key === "send_client" && !["done", "skipped"].includes(st.status);
          if (!canRetry && !canSkip && !canConfirm && !canCopy && !(st.status === "waiting_owner" && st.proposal_id)) return null;
          return (
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              {canConfirm && (
                <button onClick={() => { if (window.confirm(`Move ${form.business_name}'s deal to "First Cycle" in the PMU Bookings On Demand pipeline?`)) void act("confirm", { key: s.key }, `confirm:${s.key}`); }} disabled={!!busy}
                  className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-[#15B7AE] hover:bg-[#0e8f88] text-white disabled:opacity-50">
                  {busy === `confirm:${s.key}` ? <Loader2 size={11} className="animate-spin inline" /> : "▶"} Approve — move to First Cycle
                </button>
              )}
              {canCopy && (
                <button onClick={() => void copyClientMessage()} disabled={!!busy}
                  className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-[#4f46e5] hover:bg-[#4338ca] text-white disabled:opacity-50">
                  {busy === "copy" ? <Loader2 size={11} className="animate-spin inline" /> : "📋"} Copy the message
                </button>
              )}
              {canCopy && (
                <button onClick={() => void copyAppPicture()} disabled={!!busy}
                  className="px-2.5 py-1 rounded-md text-[11px] font-semibold border border-[#c9dbfb] text-[#2f5fb8] hover:bg-[#f7faff] disabled:opacity-50">
                  {busy === "picture" ? <Loader2 size={11} className="animate-spin inline" /> : "📱"} Copy app picture
                </button>
              )}
              {st.status === "waiting_owner" && st.proposal_id && card?.status === "pending" && (
                <a href={`/ask?view=agent&p=${encodeURIComponent(st.proposal_id)}`} className="px-2 py-1 rounded-md text-[11px] font-semibold bg-[#fff1df] text-[#b35a00] hover:bg-[#ffe6c7]">✋ Approve in the AI tab</a>
              )}
              {canRetry && (
                <button onClick={() => void act("retry", { key: s.key }, `retry:${s.key}`)} disabled={!!busy}
                  className="px-2 py-1 rounded-md text-[11px] font-semibold border border-[#c9dbfb] text-[#2f5fb8] hover:bg-[#f7faff] disabled:opacity-50">
                  {busy === `retry:${s.key}` ? <Loader2 size={11} className="animate-spin inline" /> : "↻"} Retry
                </button>
              )}
              {s.optional && canSkip && st.status !== "failed" && (
                <button onClick={() => void act("skip", { key: s.key, note: "not needed" }, `skip:${s.key}`)} disabled={!!busy}
                  className="px-2 py-1 rounded-md text-[11px] font-semibold border border-[#d7e0ea] text-[#64748b] hover:bg-[#f8fafc] disabled:opacity-50">Not needed</button>
              )}
              {/* One click (owner 10/20/2026) — no note box in between. */}
              {canSkip && (
                <button onClick={() => void act("skip", { key: s.key, note: byHand ? "completed" : "approved manually" }, `skip:${s.key}`)} disabled={!!busy}
                  className={cn("px-2 py-1 rounded-md text-[11px] font-semibold border disabled:opacity-50", byHand ? "border-[#bfe3cd] text-[#15803d] hover:bg-[#f3fbf6]" : "border-[#d7e0ea] text-[#64748b] hover:bg-[#f8fafc]")}>
                  {busy === `skip:${s.key}` ? <Loader2 size={11} className="animate-spin inline" /> : "✓"} {byHand ? "Mark completed" : "Approve manually"}
                </button>
              )}
            </div>
          );
        }} />
    </div>
  );
}

/* The result's first line, with the rest (the Mac Mini's step-by-step
   report) folded behind "details" — warnings and failures stay open. */
/* One line by default for every step (owner 2026-10-20: the notes were too
   much text); click it to read the whole note, click again to fold it. */
/* Meta pixel on the pre-flight: pick one of the agency's shared pixels from a
   dropdown (most-used first), type another, or leave it for later (owner
   10/26/2026). The picked / typed value lands in form.meta_pixel_id as before. */
function PixelPicker({ value, pixels, onChange }: { value: string; pixels: SharedPixel[]; onChange: (v: string) => void }) {
  const digits = value.replace(/\D/g, "");
  const known = pixels.some((p) => p.id === digits);
  const [other, setOther] = useState(false);
  const mode = NO_PIXEL_RE.test(value) ? "later" : known && !other ? digits : other || value ? "other" : "";
  return (
    <span className="mt-0.5 flex items-center gap-1.5 flex-wrap">
      <select
        value={mode}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "later") { setOther(false); onChange("later"); }
          else if (v === "other") { setOther(true); onChange(""); }
          else { setOther(false); onChange(v); }
        }}
        className="px-2 py-1 rounded-md border border-[#d7e0ea] bg-white text-xs max-w-full"
      >
        <option value="">Pick a pixel…</option>
        {pixels.map((p) => (
          <option key={p.id} value={p.id}>{p.id} · {p.clients} clients{p.sample.length ? ` (${p.sample.join(", ")}…)` : ""}</option>
        ))}
        <option value="other">Another pixel (type it)</option>
        <option value="later">Add it later (final check reminds us)</option>
      </select>
      {mode === "other" && (
        <input autoFocus value={value} onChange={(e) => onChange(e.target.value)} placeholder="e.g. 1234567890123456" className="flex-1 min-w-[12rem] px-2 py-1 rounded-md border border-[#d7e0ea] bg-white text-xs" />
      )}
    </span>
  );
}

function StepNote({ note, status }: { note: string; status: StepState["status"] }) {
  const [open, setOpen] = useState(false);
  const cls = status === "failed" ? "text-[#b91c1c]" : status === "warn" ? "text-[#c2410c]" : "text-[#697a91]";
  return (
    <button type="button" onClick={() => setOpen((v) => !v)} title={open ? "Click to fold" : "Click to read the whole note"}
      className={cn("block w-full text-left text-[11px]", cls, open ? "whitespace-pre-wrap" : "truncate")}>
      {open ? note.trim() : note.replace(/\s+/g, " ").trim()}
    </button>
  );
}

/* Step 3's custom values, live from the sub-account: what's filled, what's
   empty, and an inline edit to fill one (owner, 10/17/2026). */
function CustomValuesList({ onboardingId, locationId }: { onboardingId: string; locationId: string }) {
  const [rows, setRows] = useState<Array<{ name: string; value?: string }> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [onlyEmpty, setOnlyEmpty] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await fetch(`/api/onboarding/${onboardingId}/claim?cvs=${encodeURIComponent(locationId)}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setRows(((j.customValues ?? []) as Array<{ name: string; value?: string }>).filter((c) => /^cc\s*-/i.test(c.name)).sort((a, b) => a.name.localeCompare(b.name)));
    } catch (e) { setErr(e instanceof Error ? e.message : "could not load"); }
  }, [onboardingId, locationId]);
  useEffect(() => { void load(); }, [load]);
  const save = async (name: string) => {
    setSaving(name);
    try {
      const r = await fetch(`/api/onboarding/${onboardingId}/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repairCv: { name, value: draft[name] ?? "" } }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      toast.success(`Saved: ${name}`);
      setDraft((d) => { const n = { ...d }; delete n[name]; return n; });
      await load();
    } catch (e) { toast.error(e instanceof Error ? e.message : "save failed"); }
    finally { setSaving(null); }
  };
  if (err) return <p className="text-[11px] text-[#b91c1c] mt-1">Custom values: {err}</p>;
  if (!rows) return <p className="text-[11px] text-[#8595a8] mt-1 flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> loading custom values…</p>;
  const empty = rows.filter((r) => !String(r.value ?? "").trim()).length;
  const shown = onlyEmpty ? rows.filter((r) => !String(r.value ?? "").trim()) : rows;
  return (
    <div className="mt-1 rounded-md border border-[#eef3f8] bg-[#fbfdff]">
      <div className="flex items-center gap-3 px-2 py-1 text-[10.5px] text-[#697a91] border-b border-[#eef3f8]">
        <span><b className="text-[#15803d]">{rows.length - empty}</b> filled · <b className={empty ? "text-[#b91c1c]" : ""}>{empty}</b> empty</span>
        <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={onlyEmpty} onChange={(e) => setOnlyEmpty(e.target.checked)} /> only empty</label>
        <button onClick={() => void load()} className="ml-auto text-[#0e8f88] hover:underline flex items-center gap-1"><RefreshCw size={10} /> refresh</button>
      </div>
      <ul className="max-h-72 overflow-y-auto divide-y divide-[#f1f5f9]">
        {shown.map((c) => {
          const val = String(c.value ?? "");
          const editing = c.name in draft;
          return (
            <li key={c.name} className="px-2 py-1 flex items-center gap-2 text-[11px]">
              <span className="w-56 shrink-0 truncate text-[#34568a]" title={c.name}>{c.name}</span>
              {editing ? (
                <>
                  <input autoFocus value={draft[c.name]} onChange={(e) => setDraft((d) => ({ ...d, [c.name]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === "Enter") void save(c.name); if (e.key === "Escape") setDraft((d) => { const n = { ...d }; delete n[c.name]; return n; }); }}
                    className="flex-1 min-w-0 px-1.5 py-0.5 rounded border border-[#c9dbfb] text-[11px]" />
                  <button onClick={() => void save(c.name)} disabled={saving === c.name} className="px-1.5 py-0.5 rounded bg-[#15B7AE] text-white text-[10px] font-semibold disabled:opacity-50">{saving === c.name ? "…" : "Save"}</button>
                </>
              ) : (
                <button onClick={() => setDraft((d) => ({ ...d, [c.name]: val }))} title="Click to edit"
                  className={cn("flex-1 min-w-0 text-left truncate hover:underline", val.trim() ? "text-[#1f3559]" : "text-[#b91c1c] italic")}>
                  {val.trim() ? val : "empty — click to fill"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PlanList({ steps, setup, cards, actions, onboardingId, isAdmin = false }: {
  steps: RunbookStep[]; setup: Setup | null; cards: Record<string, Card>;
  actions?: (s: RunbookStep, st: StepState) => React.ReactNode;
  onboardingId?: string; isAdmin?: boolean;
}) {
  const [cvOpen, setCvOpen] = useState(false);
  const videos = useStepVideos();
  /* Once a run exists: finished steps on the left, what's left on the right,
     so a coach sees at a glance what the AI Agent did and what is hers
     (owner 2026-10-20 — the single long list used half the screen). */
  const isDone = (s: RunbookStep) => ["done", "skipped", "warn"].includes(setup?.steps?.[s.key]?.status ?? "todo");
  if (setup) {
    const done = steps.filter(isDone);
    const todo = steps.filter((s) => !isDone(s));
    // A step the AI Agent failed is a person's job now.
    const byAgent = todo.filter((s) => AGENT.includes(s.who) && setup.steps?.[s.key]?.status !== "failed").length;
    return (
      <div className="mt-1.5 grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
        <div className="min-w-0">
          <p className="mb-1.5 text-xs font-bold text-[#15803d]">✅ Done · {done.length}</p>
          {done.length ? renderSections(done) : <p className="text-xs text-[#8595a8]">Nothing finished yet.</p>}
        </div>
        <div className="min-w-0">
          <p className="mb-1.5 text-xs font-bold text-[#b35a00]">📝 To do · {todo.length}
            <span className="font-normal text-[#697a91]"> · 🤖 {byAgent} by the AI Agent · 👤 {todo.length - byAgent} by hand</span></p>
          {todo.length ? renderSections(todo) : <p className="text-xs text-[#15803d]">All steps are done.</p>}
        </div>
      </div>
    );
  }
  return renderSections(steps);

  function renderSections(list: RunbookStep[]) {
  return (
    <div className="mt-1.5 space-y-2">
      {RUNBOOK_SECTIONS.map((section) => {
        const sec = list.filter((s) => s.section === section);
        if (!sec.length) return null;
        return (
          <div key={section} className="rounded-lg border border-[#eef3f8] bg-white overflow-hidden">
            <div className="px-3 py-1.5 bg-[#f8fafc] text-[11px] font-bold text-[#34568a]">{section}</div>
            <ul className="divide-y divide-[#f1f5f9]">
              {sec.map((s) => {
                const st: StepState = setup?.steps?.[s.key] ?? { status: "todo" };
                const card = st.proposal_id ? cards[st.proposal_id] : undefined;
                const ic = setup ? stepIcon(st, card) : null;
                const shots = (st.screenshots?.length ? st.screenshots : card?.screenshots) ?? [];
                const settledLine = st.at && ["done", "warn", "failed", "skipped"].includes(st.status) ? `${st.who ?? ""} · ${usWhen(st.at)}` : "";
                return (
                  <li key={s.key} className="px-3 py-1 flex items-start gap-2">
                    <span className="w-6 shrink-0 text-[11px] text-[#8595a8] tabular-nums mt-0.5">{s.n}</span>
                    {/* Who / when lives in the tooltip — owner 2026-10-20 wanted the lines clean. */}
                    {ic && <span className={cn("w-4 shrink-0 text-[13px] leading-5", ic.cls)} title={[ic.label, settledLine].filter(Boolean).join(" · ")}>{ic.icon}</span>}
                    <div className="min-w-0 flex-1">
                      {/* Line 1: name · who · when · screenshots — the description is a tooltip once settled */}
                      <div className="flex items-center gap-2 flex-wrap">
                        {s.key === "account_cvs" && setup && onboardingId ? (
                          <button onClick={() => setCvOpen((v) => !v)} title={s.label}
                            className="text-[12.5px] font-semibold text-[#0e8f88] hover:underline">{s.title ?? s.label} {cvOpen ? "▴" : "▾"}</button>
                        ) : (
                          <span title={s.label} className={cn("text-[12.5px] font-semibold", st.status === "done" || st.status === "skipped" ? "text-[#475569]" : "text-[#1f3559]")}>{s.title ?? s.label}</span>
                        )}
                        <span className={cn("text-[9.5px] font-bold px-1.5 py-px rounded-full whitespace-nowrap", WHO_STYLE[s.badge ?? s.who])}>{WHO_LABEL[s.badge ?? s.who]}</span>
                        {setup && st.status === "failed" && AGENT.includes(s.who) && (
                          <span className="text-[9.5px] font-bold px-1.5 py-px rounded-full whitespace-nowrap bg-[#fde8ee] text-[#e11d48]">👤 needs a person</span>
                        )}
                        {shots.length > 0 && <ScreenshotGallery shots={shots} variant="chip" />}
                      </div>
                      {s.title && !["done", "skipped"].includes(st.status) && <p className="text-[10.5px] text-[#8595a8] truncate" title={s.label}>{s.label}</p>}
                      {/* By-hand breakdown for the team (Facebook) — how to do it, with the Loom / docs. */}
                      {s.steps && !["done", "skipped"].includes(st.status) && (
                        <div className="mt-0.5">
                          <ul className="text-[10.5px] text-[#475569] list-disc pl-4 space-y-px">{s.steps.map((t) => <li key={t}>{t}</li>)}</ul>
                          {s.links && <p className="text-[10.5px] mt-0.5 flex gap-2 flex-wrap">{s.links.map((l) => <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer" className="text-[#0e8f88] hover:underline">{l.label} ↗</a>)}</p>}
                        </div>
                      )}
                      {!setup && s.how && <p className="text-[10.5px] text-[#8595a8] truncate" title={s.how}>{s.how}</p>}
                      {/* How-to clips for doing this step by hand (owner 10/29/2026). */}
                      <StepVideos stepKey={s.key} stepLabel={`${s.n}. ${s.title ?? s.label}`} videos={videos.byStep[s.key] ?? []} isAdmin={isAdmin} onChanged={videos.reload} />
                      {ic?.label && !["done", "skipped"].includes(st.status) && <p className={cn("text-[10.5px] font-semibold", ic.cls)}>{ic.label}</p>}
                      {st.note && setup && <StepNote note={st.note} status={st.status} />}
                      {s.key === "account_cvs" && cvOpen && setup?.location_id && onboardingId && <CustomValuesList onboardingId={onboardingId} locationId={setup.location_id} />}
                      {actions?.(s, st)}
                    </div>
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
}
