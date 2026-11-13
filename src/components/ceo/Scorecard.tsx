"use client";
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { MonthPlan, type Plan } from "@/components/ceo/MonthPlan";
import type { ScoreStatus } from "@/lib/ceo-plan";
import { MarketingTracker } from "@/components/ceo/MarketingTracker";

/* The numbers game (owner, 2026-11-13: the month plan "has too much text…
   just show me leads → demos → closed, then three goals — new cash,
   retention, deposits — with the goal for the month and on track or not").
   Few words and a number each; the plan's to-do lists sit behind one click. */

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

function Chip({ status }: { status: ScoreStatus }) {
  const s = status === "hit" ? ["Goal hit ✓", "bg-[#dcfce7] text-[#15803d] border-[#bbf7d0]"]
    : status === "on" ? ["On track", "bg-[#eefaf9] text-[#0f8f88] border-[#bfe6e3]"]
    : status === "behind" ? ["Behind", "bg-[#fee2e2] text-[#b91c1c] border-[#fecaca]"]
    : ["No data yet", "bg-[#f8fafc] text-[#8595a8] border-[#e4ebf2]"];
  return <span className={cn("shrink-0 px-2 py-0.5 rounded-full text-[11px] font-bold border", s[1])}>{s[0]}</span>;
}

function Goal({ title, big, status, goal, line }: { title: string; big: string; status: ScoreStatus; goal: string; line: string }) {
  return (
    <div className="rounded-lg border border-[#e4ebf2] bg-[#fbfdfe] px-3 py-2.5 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-[#8595a8]">{title}</p>
        <Chip status={status} />
      </div>
      <p className="mt-1 text-2xl font-bold tabular-nums text-[#1f3559] leading-tight">{big}</p>
      <p className="text-[12px] text-[#34568a] mt-0.5">Goal: <b>{goal}</b></p>
      <p className="text-[11px] text-[#8595a8] mt-0.5">{line}</p>
    </div>
  );
}

function Step({ label, n, sub }: { label: string; n: number; sub?: string }) {
  return (
    <div className="text-center min-w-[72px]">
      <p className="text-2xl font-bold tabular-nums text-[#1f3559] leading-tight">{n}</p>
      <p className="text-[12px] font-semibold text-[#34568a]">{label}</p>
      {sub && <p className="text-[11px] text-[#8595a8]">{sub}</p>}
    </div>
  );
}

export function Scorecard() {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showPlan, setShowPlan] = useState(false);

  useEffect(() => {
    fetch("/api/ceo/plan").then((r) => r.json()).then((j) => {
      if (j.error) setErr(j.error); else setPlan(j);
    }).catch((e) => setErr(String(e)));
  }, []);

  if (err) return <div className="rounded-lg border border-[#fcd9a8] bg-[#fff7ec] px-3 py-2 text-xs text-[#b45309]">This month&apos;s numbers unavailable: {err}</div>;
  if (!plan) return <div className="rounded-xl border border-[#e4ebf2] bg-white p-3 text-xs text-[#8595a8] flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Counting this month…</div>;

  const s = plan.score;
  const f = s.funnel;
  const keptBig = s.keep.lastKeptPct == null ? "—" : `${s.keep.lastKeptPct}% kept`;
  const keptLine = s.keep.lastLost == null
    ? `${plan.label} so far: ${s.keep.atRisk} to chase`
    : `${s.keep.lastLabel}: ${s.keep.lastLost} of ${s.keep.lastPaying} stopped · ${plan.label} so far: ${s.keep.atRisk} to chase`;

  return (
    <>
    <div className="rounded-xl border border-[#a7e3df] bg-white p-3 space-y-2.5" style={{ boxShadow: "var(--shadow-sm)" }}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-[#1f3559]">📊 {plan.label} so far</h2>
        <span className="text-xs text-[#697a91]">day {s.day} of {s.days}</span>
      </div>

      {/* Leads → demos → closed, this month, with last month under it */}
      <div className="rounded-lg border border-[#e4ebf2] px-3 py-2">
        <div className="flex items-center justify-center gap-3 sm:gap-6">
          <Step label="Leads" n={f.leads} sub="booked a call" />
          <span className="text-[#bfe6e3] text-xl">→</span>
          <Step label="Demos" n={f.demos} sub={`${pct(f.demos, f.leads)} of leads`} />
          <span className="text-[#bfe6e3] text-xl">→</span>
          <Step label="Closed" n={f.closes} sub={`paid · ${pct(f.closes, f.demos)} of demos`} />
        </div>
        <p className="text-center text-[11px] text-[#8595a8] mt-1.5">
          {f.last.label}: {f.last.leads} → {f.last.demos} → {f.last.closes}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <Goal title="1 · New cash" big={usd(s.cash.now)} status={s.cash.status}
          goal={`${usd(s.cash.goal)} · ${s.cash.closesGoal} new clients`}
          line={`${s.cash.closes} of ${s.cash.closesGoal} clients · on pace for ${usd(s.cash.pace)} · ${s.cash.lastLabel} ${usd(s.cash.last)}`} />
        <Goal title="2 · Keep clients" big={keptBig} status={s.keep.status}
          goal={`${s.keep.lostMax} or fewer stop paying`}
          line={keptLine} />
        <Goal title="3 · Deposits" big={usd(s.deposits.now)} status={s.deposits.status}
          goal={usd(s.deposits.goal)}
          line={`on pace for ${usd(s.deposits.pace)} · ${s.deposits.lastLabel} ${usd(s.deposits.last)}`} />
      </div>

      <button onClick={() => setShowPlan((v) => !v)} aria-expanded={showPlan}
        className="flex items-center gap-1 text-[12px] font-semibold text-[#0f8f88] hover:underline">
        {showPlan ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {showPlan ? "Hide the to-do lists" : "See the to-do lists"}
      </button>
      {showPlan && <MonthPlan initial={plan} />}
    </div>
    <MarketingTracker m={plan.marketing} />
    </>
  );
}
