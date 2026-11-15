"use client";
import { cn } from "@/lib/utils";
import type { GoalPath } from "@/lib/ceo-plan";

/* 🎯 Road to the goal (owner, 11/15/2026). Top: profit per month — real
   months as solid bars, the goal line to $100k as outlined bars. Below:
   what a normal month brings today vs what each month needs (ad spend →
   leads → demos → new clients), with this month so far. Few words and
   numbers; how it's counted sits behind a click. Math: lib/ceo-plan.ts. */

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const k = (n: number) => `$${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;

function Compare({ label, now, need, fmt, sofar }: { label: string; now: number; need: number; fmt: (n: number) => string; sofar?: string }) {
  const max = Math.max(now, need, 1);
  const short = now < need;
  return (
    <div className="rounded-lg border border-[#e4ebf2] bg-[#fbfdfe] px-3 py-2.5 min-w-0">
      <p className="text-[12px] font-semibold uppercase tracking-wide text-[#8595a8]">{label}</p>
      <div className="mt-1.5 space-y-1.5">
        <div>
          <div className="flex justify-between text-[11px] text-[#697a91]"><span>Now</span><b className="text-[#1f3559] tabular-nums">{fmt(now)}</b></div>
          <div className="h-2 rounded-full bg-[#eef2f6]"><div className="h-2 rounded-full bg-[#94a3b8]" style={{ width: `${(now / max) * 100}%` }} /></div>
        </div>
        <div>
          <div className="flex justify-between text-[11px] text-[#697a91]"><span>Needed</span><b className={cn("tabular-nums", short ? "text-[#b45309]" : "text-[#15803d]")}>{fmt(need)}</b></div>
          <div className="h-2 rounded-full bg-[#eef2f6]"><div className="h-2 rounded-full bg-[#15B7AE]" style={{ width: `${(need / max) * 100}%` }} /></div>
        </div>
      </div>
      {sofar && <p className="mt-1.5 text-[11px] text-[#8595a8]">{sofar}</p>}
    </div>
  );
}

export function GoalPathChart({ g }: { g: GoalPath }) {
  const bars = [
    ...g.history.map((h) => ({ key: h.ym, label: h.label.slice(0, 3), value: h.profit, goal: false, current: false })),
    ...g.months.map((m) => ({ key: m.ym, label: m.label.slice(0, 3), value: m.profitGoal, goal: true, current: m.current })),
  ];
  const top = Math.max(...bars.map((b) => b.value), 1);
  const t = g.thisMonth;
  const times = g.now.newClients > 0 ? Math.round((g.need.newClients / g.now.newClients) * 10) / 10 : null;
  return (
    <div className="rounded-xl border border-[#a7e3df] bg-white p-3 space-y-3" style={{ boxShadow: "var(--shadow-sm)" }}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-[#1f3559]">🎯 Road to $100k profit a month</h2>
        <span className="text-xs text-[#697a91]">by {g.months[g.months.length - 1]?.label}</span>
      </div>

      {/* Profit per month: real (solid) → goal (outlined) */}
      <div className="rounded-lg border border-[#e4ebf2] px-3 pt-3 pb-2">
        <div className="flex items-end gap-1.5 sm:gap-3 h-40">
          {bars.map((b) => (
            <div key={b.key} className="flex-1 min-w-0 flex flex-col items-center justify-end h-full">
              <span className={cn("text-[10px] sm:text-[11px] font-semibold tabular-nums mb-0.5", b.goal ? "text-[#0f8f88]" : "text-[#1f3559]")}>{k(b.value)}</span>
              <div className={cn("w-full max-w-[44px] rounded-t-md", b.goal ? "border-2 border-dashed border-[#15B7AE] bg-[#eefaf9]" : "bg-[#1f3559]", b.current && "border-solid bg-[#c9efeb]")}
                style={{ height: `${(b.value / top) * 100}%` }} />
              <span className={cn("mt-1 text-[11px]", b.current ? "font-bold text-[#0f8f88]" : "text-[#697a91]")}>{b.label}</span>
            </div>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-3 text-[11px] text-[#697a91]">
          <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-[#1f3559]" /> Real profit</span>
          <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded-sm border-2 border-dashed border-[#15B7AE] bg-[#eefaf9]" /> Goal</span>
        </div>
      </div>

      {/* Now vs needed, every month */}
      <div>
        <p className="text-[12px] text-[#34568a] mb-1.5">
          <b>Every month until the goal</b> you need about <b>{g.need.newClients} new clients</b>
          {times ? <> — {times}× what a month brings now</> : null}.
        </p>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <Compare label="Ad spend" now={g.now.spend} need={g.need.spend} fmt={usd} sofar={t ? `${t.label}: ${t.spend == null ? "not entered yet" : usd(t.spend)}` : undefined} />
          <Compare label="Leads" now={g.now.leads} need={g.need.leads} fmt={(n) => String(n)} sofar={t ? `${t.label} so far: ${t.leads}` : undefined} />
          <Compare label="Demos booked" now={g.now.demos} need={g.need.demos} fmt={(n) => String(n)} sofar={t ? `${t.label} so far: ${t.demos}` : undefined} />
          <Compare label="New clients" now={g.now.newClients} need={g.need.newClients} fmt={(n) => String(n)} sofar={t ? `${t.label} so far: ${t.newClients}` : undefined} />
        </div>
      </div>

      <details className="text-[11px] text-[#697a91]">
        <summary className="cursor-pointer font-semibold text-[#0f8f88]">How this is counted</summary>
        <p className="mt-1.5">
          &quot;Now&quot; = the average month of {g.basis.join(", ")}. The goal line goes straight from {g.history[g.history.length - 1]?.label}&apos;s
          profit to $100k. Each month needs new clients to replace the ~{g.now.lost} who stop paying, plus enough new monthly payments
          (about {usd(g.now.avgPay)} each) to climb to the next goal. Leads, demos and ad spend grow at today&apos;s rates per new client.
          Leads = booked a discovery call. Deposit growth is not counted here, so it is extra cushion.
        </p>
      </details>
    </div>
  );
}
