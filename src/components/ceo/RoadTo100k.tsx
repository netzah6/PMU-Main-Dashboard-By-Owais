"use client";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/* "Road to $100k/mo profit" (owner, 2026-10-03). The profit gap and the four
   levers that close it, month by month — green when a month hit the target,
   red when it missed. The current month is still filling in (greyed). */

type M = {
  ym: string; label: string; partial: boolean;
  profit: number | null; payingClients: number; newClients: number; lostClients: number | null;
  under500: number; avgPerClient: number | null;
  ppsDeposits: number; ppsFees: number; ppsIncome: number;
  demosBooked: number; demosShowed: number; demosClosed: number; noShowPct: number | null;
  adSpend: number | null; adPerClose: number | null;
};
type Targets = { lostMax: number; ppsMin: number; under500Max: number; noShowMaxPct: number; closesMin: number };

const usd = (n: number | null | undefined) => (n == null ? "—" : `$${Math.round(n).toLocaleString()}`);
const k = (n: number | null | undefined) => (n == null ? "—" : `$${(n / 1000).toFixed(1)}k`);

export function RoadTo100k() {
  const [months, setMonths] = useState<M[] | null>(null);
  const [goal, setGoal] = useState(100_000);
  const [t, setT] = useState<Targets | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/ceo/growth").then((r) => r.json()).then((j) => {
      if (j.error) setErr(j.error);
      setMonths(j.months ?? []); setGoal(j.goal ?? 100_000); setT(j.targets ?? null);
    }).catch((e) => setErr(String(e)));
  }, []);

  if (err && !months?.length) return <div className="rounded-lg border border-[#fcd9a8] bg-[#fff7ec] px-3 py-2 text-xs text-[#b45309]">Road to $100k unavailable: {err}</div>;
  if (!months || !t) return <div className="rounded-xl border border-[#e4ebf2] bg-white p-3 text-xs text-[#8595a8] flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Loading Road to $100k…</div>;

  const done = months.filter((m) => !m.partial);
  const last = done[done.length - 1];
  const pct = last?.profit != null ? Math.min(100, Math.round((last.profit / goal) * 100)) : 0;
  const shown = months.slice(-7);

  // good = hit the target, bad = missed, null = no target / partial month
  const cell = (m: M, ok: boolean | null, text: string, title?: string) => (
    <td key={m.ym} title={title}
      className={cn("px-2 py-1 text-center whitespace-nowrap tabular-nums",
        m.partial ? "text-[#a6b3c4]" : ok === true ? "bg-[#e7f6ec] text-[#15803d] font-semibold" : ok === false ? "bg-[#fde8ee] text-[#b91c1c] font-semibold" : "text-[#1f3559]")}>
      {text}
    </td>
  );

  const rows: Array<{ label: string; target: string; render: (m: M) => React.ReactNode }> = [
    { label: "Profit", target: k(goal), render: (m) => cell(m, m.profit != null ? m.profit >= goal : null, k(m.profit)) },
    { label: "1 · Clients lost", target: `≤ ${t.lostMax}`, render: (m) => cell(m, m.lostClients != null ? m.lostClients <= t.lostMax : null, m.lostClients == null ? "—" : String(m.lostClients), "Paid last month, nothing this month (a skipped payment counts too)") },
    { label: "   New clients · paying", target: "", render: (m) => cell(m, null, `+${m.newClients} · ${m.payingClients}`, "First-time payers · clients who paid this month") },
    { label: "2 · PPS money", target: `≥ ${k(t.ppsMin)}`, render: (m) => cell(m, m.ppsIncome >= t.ppsMin, k(m.ppsIncome), `${usd(m.ppsDeposits)} lead deposits kept + ${usd(m.ppsFees)} per-show fees`) },
    { label: "3 · Paying under $500", target: `${t.under500Max}`, render: (m) => cell(m, m.under500 <= t.under500Max, String(m.under500), "Clients whose total payment this month was under $500") },
    { label: "   Avg per client", target: "", render: (m) => cell(m, null, usd(m.avgPerClient)) },
    { label: "4 · Demos → closed", target: `≥ ${t.closesMin} closed`, render: (m) => cell(m, m.demosClosed >= t.closesMin, `${m.demosBooked} → ${m.demosClosed}`, `${m.demosBooked} booked · ${m.demosShowed} showed · ${m.demosClosed} closed`) },
    { label: "   No-show / cancel", target: `≤ ${t.noShowMaxPct}%`, render: (m) => cell(m, m.noShowPct != null ? m.noShowPct <= t.noShowMaxPct : null, m.noShowPct == null ? "—" : `${m.noShowPct}%`, "No-shows + cancellations ÷ demos booked") },
    { label: "   Ad $ per close", target: "", render: (m) => cell(m, null, usd(m.adPerClose), m.adSpend != null ? `${usd(m.adSpend)} FB ads ÷ ${m.demosClosed} closed` : undefined) },
  ];

  return (
    <div className="rounded-xl border border-[#cfe3f7] bg-white p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-[#1f3559]">🎯 Road to {k(goal)}/mo profit</h2>
        {last && <span className="text-xs text-[#697a91]">{last.label}: <b className="text-[#1f3559]">{k(last.profit)}</b> · gap <b className="text-[#b91c1c]">{k(goal - (last.profit ?? 0))}</b></span>}
      </div>
      <div className="h-2.5 rounded-full bg-[#eef3f8] overflow-hidden">
        <div className="h-full rounded-full bg-[#15B7AE]" style={{ width: `${pct}%` }} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-[#8595a8]">
              <th className="px-2 py-1 text-left font-medium">Lever</th>
              <th className="px-2 py-1 text-center font-medium">Target</th>
              {shown.map((m) => <th key={m.ym} className="px-2 py-1 text-center font-medium">{m.label.slice(0, 3)}{m.partial ? " (so far)" : ""}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-t border-[#f1f5f9]">
                <td className={cn("px-2 py-1 whitespace-nowrap", r.label.startsWith(" ") ? "pl-5 text-[#697a91]" : "font-semibold text-[#1f3559]")}>{r.label.trim()}</td>
                <td className="px-2 py-1 text-center text-[#697a91] whitespace-nowrap">{r.target}</td>
                {shown.map((m) => r.render(m))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-[#8595a8]">
        From the Financing sheet (profit, payers, deposits, FB ads), the PPS per-show charges and the Demos sheet. &ldquo;Lost&rdquo; = paid last month but not this month, so a skipped payment counts. The current month is still filling in.
      </p>
    </div>
  );
}
