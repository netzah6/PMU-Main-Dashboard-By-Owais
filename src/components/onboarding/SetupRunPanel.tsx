"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw, Check, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { RUNBOOK, RUNBOOK_SECTIONS, WHO_LABEL, type RunbookStep, type SetupState, type StepState, type Who } from "@/lib/setup-runbook";

/* The New Client Setup run on an Onboarding card.
   Before Approve: which clean account it will take (dropdown), the 38-step
   plan with who does each, and the Approve button. Nothing touches GHL
   before that click.
   After: a banner (running / needs you / done / failed), every step with
   its tick, who did it, when (US dates), the Mac Mini's screenshots, Retry
   / Skip on a failed step, and the final summary text. */

type Card = { status: string; screenshots: Array<{ name: string; url: string }>; result: string | null };
type Pool = { choices: Array<{ id: string; name: string; readiness: string; blocker: string | null }>; defaultId: string | null; note?: string };
type Setup = Omit<SetupState, "password"> & { has_password: boolean };
type Data = { setup: Setup | null; cards: Record<string, Card>; pool: Pool | null; claimedLocation: string | null; canApprove: boolean };

const WHO_STYLE: Record<Who, string> = {
  api: "bg-[#e4f5e9] text-[#1b7f3a]", mini: "bg-[#e6edfb] text-[#2f5fb8]", ask: "bg-[#fff1df] text-[#b35a00]",
  owner: "bg-[#fff1df] text-[#b35a00]", team: "bg-[#ece9fb] text-[#6b5bd1]", client: "bg-[#eceff3] text-[#6b7280]",
};
const usWhen = (iso?: string) => (iso ? new Date(iso).toLocaleString("en-US", { month: "2-digit", day: "2-digit", year: "numeric", hour: "numeric", minute: "2-digit" }) : "");

function stepIcon(st: StepState, card?: Card): { icon: string; cls: string; label: string } {
  const live = card?.status;
  if (st.status === "queued" || st.status === "waiting_owner" || st.status === "running") {
    if (live === "running") return { icon: "🖥️", cls: "text-[#2f5fb8]", label: "Mac Mini working…" };
    if (live === "queued_browser") return { icon: "⏳", cls: "text-[#b35a00]", label: "waiting for the Mac Mini" };
    if (live === "pending" || st.status === "waiting_owner") return { icon: "✋", cls: "text-[#b35a00]", label: "needs your Approve (AI tab)" };
    if (live === "denied") return { icon: "✗", cls: "text-[#e11d48]", label: "denied in the AI tab — Retry to file it again" };
    if (st.status === "running") return { icon: "⟳", cls: "text-[#2f5fb8]", label: "dashboard working…" };
    return { icon: "⏳", cls: "text-[#b35a00]", label: "queued" };
  }
  switch (st.status) {
    case "done": return { icon: "✓", cls: "text-[#15803d]", label: "done" };
    case "warn": return { icon: "⚠", cls: "text-[#c2410c]", label: "done, look at this" };
    case "failed": return { icon: "✗", cls: "text-[#e11d48]", label: "failed" };
    case "skipped": return { icon: "↷", cls: "text-[#64748b]", label: "done by hand" };
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
  const [password, setPassword] = useState<string | null>(null);
  const [skipKey, setSkipKey] = useState<string | null>(null);
  const [skipNote, setSkipNote] = useState("");

  // The pool list costs a GHL call — never re-fetch it just because the
  // dropdown changed (poolId is read through a ref, not a dependency).
  const poolIdRef = useRef(poolId);
  poolIdRef.current = poolId;
  const load = useCallback(async (quiet = false) => {
    try {
      const r = await fetch(`/api/onboarding/${onboardingId}/setup`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load the setup run");
      setData(j); setErr(null);
      if (!poolIdRef.current && j.pool?.defaultId) setPoolId(j.pool.defaultId);
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
      if (action === "approve") toast.success("Approved — the account steps are running");
      if (action === "retry") toast.success("Step queued again");
      if (action === "skip") toast.success("Step marked done by hand");
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
    const needs = ["business_name", "owner_name", "email", "phone", "address", "deposit_amount", "version"].filter((k) => !String(form[k] ?? "").trim());
    return (
      <div className="rounded-xl border border-[#c9dbfb] bg-[#f7faff] p-4 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-sm font-bold text-[#1f3559]">🧩 Set up this account</h2>
            <p className="text-xs text-[#697a91] mt-0.5">The dashboard runs the account steps itself and the Mac Mini does the browser steps, with screenshots. <b>Nothing touches GoHighLevel before you approve.</b></p>
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
                  {pool.choices.length === 0 && <option value="">No clean account available</option>}
                  {pool.choices.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}{c.readiness === "ready" ? " · ready" : c.blocker ? ` · ${c.blocker}` : ""}</option>
                  ))}
                </select>
                {pick && (
                  <span className={cn("text-[11px] font-semibold px-2 py-0.5 rounded-full", pick.readiness === "ready" ? "bg-[#e4f5e9] text-[#1b7f3a]" : "bg-[#fff1df] text-[#b35a00]")}>
                    {pick.readiness === "ready" ? "empty + A2P approved" : pick.blocker ?? pick.readiness}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-[#8595a8] mt-1">Renamed to <b className="text-[#1f3559]">{form.business_name || "the business name"}</b>. Only an account still named &quot;Clean New Account N&quot; can be taken.{pool.note ? ` · ${pool.note}` : ""}</p>
            </>
          ) : <p className="text-xs text-[#697a91]">Loading the pool…</p>}
        </div>

        {needs.length > 0 && (
          <p className="text-[11px] text-[#c2410c]">⚠ Missing on the form: {needs.join(", ")}. The run uses what&apos;s there; fill these first for a clean setup.</p>
        )}

        {/* The plan */}
        <div>
          <button onClick={() => setShowPlan((v) => !v)} className="text-[11px] text-[#0e8f88] hover:underline">{showPlan ? "hide" : "show"} the 38-step plan</button>
          {showPlan && <PlanList steps={steps} setup={null} cards={{}} />}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {isAdmin ? (
            <button onClick={() => { if (window.confirm(`Approve: take "${pick?.name ?? data.claimedLocation ?? "the claimed account"}" and set up ${form.business_name}?\n\nThe account steps run now; browser steps go to the Mac Mini one by one. You'll be asked again before the phone number is bought and before the user is created.`)) void act("approve", { poolLocationId: poolId }); }}
              disabled={!!busy || (!data.claimedLocation && !poolId)}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#15803d] hover:bg-[#166534] text-white text-xs font-semibold disabled:opacity-50">
              {busy === "approve" ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} {busy === "approve" ? "Running the account steps… (1–3 min)" : "Approve & start"}
            </button>
          ) : <span className="text-xs text-[#8595a8]">Only an admin can approve the setup.</span>}
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
        ? { cls: "border-[#fcd9a8] bg-[#fff7ec] text-[#b35a00]", text: "✋ Waiting for you — approve the step in the AI tab" }
        : { cls: "border-[#c9dbfb] bg-[#f7faff] text-[#2f5fb8]", text: "⟳ Running — the dashboard and the Mac Mini are working through the steps" };
  return (
    <div className="rounded-xl border border-[#e4ebf2] bg-white p-4 space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-[#1f3559]">🧩 Setup run</h2>
          <p className="text-[11px] text-[#697a91] mt-0.5">
            Approved {usWhen(setup.approved_at)} by {setup.approved_by.split("@")[0]} · {setup.pool_name} → <b className="text-[#1f3559]">{form.business_name}</b>
            {" · "}<a href={`https://app.gohighlevel.com/v2/location/${setup.location_id}/dashboard`} target="_blank" rel="noopener noreferrer" className="text-[#0e8f88] hover:underline">open in GHL ↗</a>
            {setup.funnel_url && <> · <a href={setup.funnel_url} target="_blank" rel="noopener noreferrer" className="text-[#0e8f88] hover:underline">funnel ↗</a></>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {counts && <span className="text-xs font-semibold text-[#34568a]">{counts.done}/{counts.total} run steps</span>}
          <button onClick={() => void act("refresh", {}, "refresh")} disabled={!!busy} title="Re-check and continue the run" className="p-1.5 rounded text-[#8595a8] hover:text-[#0e8f88] disabled:opacity-50">
            <RefreshCw size={13} className={busy === "refresh" ? "animate-spin" : ""} />
          </button>
        </div>
      </div>
      <div className={cn("rounded-lg border px-3 py-2 text-xs font-semibold", banner.cls)}>{banner.text}</div>

      {setup.final_text && (
        <pre className="whitespace-pre-wrap font-sans text-[12px] text-[#1f3559] bg-[#f8fafc] rounded-lg px-3 py-2 border border-[#eef3f8]">{setup.final_text}</pre>
      )}

      {setup.has_password && isAdmin && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-[#697a91]">Employee login {form.email ? `(${form.email})` : ""}:</span>
          {password ? <code className="px-2 py-0.5 rounded bg-[#f1f5f9] text-[#1f3559]">{password}</code> : <span className="text-[#8595a8]">••••••••</span>}
          <button onClick={() => (password ? setPassword(null) : void act("password", {}, "password"))} className="flex items-center gap-1 text-[#0e8f88] hover:underline">
            {password ? <EyeOff size={12} /> : <Eye size={12} />} {password ? "hide" : "show"}
          </button>
        </div>
      )}

      <PlanList steps={steps} setup={setup} cards={data.cards}
        actions={(s, st) => {
          const card = st.proposal_id ? data.cards[st.proposal_id] : undefined;
          const failed = st.status === "failed" || card?.status === "denied";
          const canRetry = isAdmin && (failed || st.status === "warn");
          const canSkip = (isAdmin || role === "editor") && (failed || st.status === "warn" || st.status === "todo" || st.status === "queued" || st.status === "waiting_owner");
          if (!canRetry && !canSkip && !(st.status === "waiting_owner" && st.proposal_id)) return null;
          return (
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              {st.status === "waiting_owner" && st.proposal_id && card?.status === "pending" && (
                <a href={`/ask?view=agent&p=${encodeURIComponent(st.proposal_id)}`} className="px-2 py-1 rounded-md text-[11px] font-semibold bg-[#fff1df] text-[#b35a00] hover:bg-[#ffe6c7]">✋ Approve in the AI tab</a>
              )}
              {canRetry && (
                <button onClick={() => void act("retry", { key: s.key }, `retry:${s.key}`)} disabled={!!busy}
                  className="px-2 py-1 rounded-md text-[11px] font-semibold border border-[#c9dbfb] text-[#2f5fb8] hover:bg-[#f7faff] disabled:opacity-50">
                  {busy === `retry:${s.key}` ? <Loader2 size={11} className="animate-spin inline" /> : "↻"} Retry
                </button>
              )}
              {canSkip && skipKey !== s.key && (
                <button onClick={() => { setSkipKey(s.key); setSkipNote(""); }} disabled={!!busy}
                  className="px-2 py-1 rounded-md text-[11px] font-semibold border border-[#d7e0ea] text-[#64748b] hover:bg-[#f8fafc] disabled:opacity-50">Done by hand</button>
              )}
              {skipKey === s.key && (
                <span className="flex items-center gap-1.5">
                  <input value={skipNote} onChange={(e) => setSkipNote(e.target.value)} placeholder="what you did (optional)" className="px-2 py-1 rounded-md border border-[#d7e0ea] text-[11px] w-48" />
                  <button onClick={() => { void act("skip", { key: s.key, note: skipNote }, `skip:${s.key}`); setSkipKey(null); }} disabled={!!busy} className="px-2 py-1 rounded-md text-[11px] font-semibold bg-[#64748b] text-white">OK</button>
                  <button onClick={() => setSkipKey(null)} className="text-[11px] text-[#8595a8] hover:underline">cancel</button>
                </span>
              )}
            </div>
          );
        }} />
    </div>
  );
}

function PlanList({ steps, setup, cards, actions }: {
  steps: RunbookStep[]; setup: Setup | null; cards: Record<string, Card>;
  actions?: (s: RunbookStep, st: StepState) => React.ReactNode;
}) {
  return (
    <div className="mt-1.5 space-y-2">
      {RUNBOOK_SECTIONS.map((section) => {
        const sec = steps.filter((s) => s.section === section);
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
                  <li key={s.key} className="px-3 py-1.5 flex items-start gap-2">
                    <span className="w-6 shrink-0 text-[11px] text-[#8595a8] tabular-nums mt-0.5">{s.n}</span>
                    {ic && <span className={cn("w-4 shrink-0 text-[13px] leading-5", ic.cls)} title={ic.label}>{ic.icon}</span>}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start gap-2 flex-wrap">
                        <span className={cn("text-[12.5px]", st.status === "done" || st.status === "skipped" ? "text-[#64748b]" : "text-[#1f3559]")}>{s.label}</span>
                        <span className={cn("text-[9.5px] font-bold px-1.5 py-px rounded-full whitespace-nowrap", WHO_STYLE[s.who])}>{WHO_LABEL[s.who]}</span>
                      </div>
                      {!setup && s.how && <p className="text-[10.5px] text-[#8595a8]">{s.how}</p>}
                      {ic?.label && !["done", "skipped"].includes(st.status) && <p className={cn("text-[10.5px] font-semibold", ic.cls)}>{ic.label}</p>}
                      {settledLine && <p className="text-[10px] text-[#a6b3c4]">{settledLine}</p>}
                      {st.note && setup && (
                        <pre className={cn("whitespace-pre-wrap font-sans text-[11px] mt-0.5", st.status === "failed" ? "text-[#b91c1c]" : st.status === "warn" ? "text-[#c2410c]" : "text-[#697a91]")}>{st.note}</pre>
                      )}
                      {shots.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {shots.map((sh, i) => (
                            <a key={i} href={sh.url} target="_blank" rel="noreferrer" title={sh.name} className="block w-24 rounded-md border border-black/10 overflow-hidden bg-white hover:border-[#15B7AE]">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={sh.url} alt={sh.name || `Screenshot ${i + 1}`} className="w-full h-14 object-cover object-top" loading="lazy" />
                            </a>
                          ))}
                        </div>
                      )}
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
