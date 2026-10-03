"use client";
import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";

/* "Road to $100k/mo profit" (owner, 2026-10-03). Plain words, one row per
   thing to fix, green when a month hit the goal and red when it missed. Every
   underlined number opens the names behind it (owner: "make it clickable"). */

type M = {
  ym: string; label: string; partial: boolean;
  profit: number | null; income: number | null; expense: number | null;
  payingClients: number; newClients: number; lostClients: number | null;
  under500: number; avgPerClient: number | null;
  ppsDeposits: number; ppsFees: number; ppsIncome: number; ppsFeesSquare: number; ppsClients: number;
  demosBooked: number; demosShowed: number; demosClosed: number; noShowPct: number | null;
  adSpend: number | null; adPerClose: number | null;
  newList: string[]; lostList: string[];
  under500List: Array<{ name: string; amount: number }>;
  liveNotPaying: Array<{ name: string; business: string; version: string }> | null;
};
type Targets = { lostMax: number; ppsMin: number; under500Max: number; noShowMaxPct: number; closesMin: number };
type Panel = { title: string; note?: string; items: Array<{ left: string; right?: string }> };

const usd = (n: number | null | undefined) => (n == null ? "—" : `$${Math.round(n).toLocaleString()}`);
const k = (n: number | null | undefined) => (n == null ? "—" : `$${(n / 1000).toFixed(1)}k`);

export function RoadTo100k() {
  const [months, setMonths] = useState<M[] | null>(null);
  const [goal, setGoal] = useState(100_000);
  const [t, setT] = useState<Targets | null>(null);
  const [liveCount, setLiveCount] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);

  useEffect(() => {
    fetch("/api/ceo/growth").then((r) => r.json()).then((j) => {
      if (j.error) setErr(j.error);
      setMonths(j.months ?? []); setGoal(j.goal ?? 100_000); setT(j.targets ?? null); setLiveCount(j.liveCount ?? null);
    }).catch((e) => setErr(String(e)));
  }, []);

  if (err && !months?.length) return <div className="rounded-lg border border-[#fcd9a8] bg-[#fff7ec] px-3 py-2 text-xs text-[#b45309]">Road to $100k unavailable: {err}</div>;
  if (!months || !t) return <div className="rounded-xl border border-[#e4ebf2] bg-white p-3 text-xs text-[#8595a8] flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Loading Road to $100k…</div>;

  const done = months.filter((m) => !m.partial);
  const last = done[done.length - 1];
  const pct = last?.profit != null ? Math.min(100, Math.round((last.profit / goal) * 100)) : 0;
  const shown = months.slice(-7);

  const open = (p: Panel) => setPanel(p);
  // One cell: green = goal hit, red = missed, plain = no goal; greyed while the month is still running.
  const cell = (m: M, ok: boolean | null, text: string, onClick?: () => void, title?: string) => (
    <td key={m.ym} title={title}
      className={cn("px-2 py-1.5 text-center whitespace-nowrap tabular-nums",
        m.partial ? "text-[#a6b3c4]" : ok === true ? "bg-[#e7f6ec] text-[#15803d] font-semibold" : ok === false ? "bg-[#fde8ee] text-[#b91c1c] font-semibold" : "text-[#1f3559]")}>
      {onClick ? <button onClick={onClick} className="underline decoration-dotted underline-offset-2 hover:opacity-70">{text}</button> : text}
    </td>
  );

  const rows: Array<{ label: string; help: string; goal: string; sub?: boolean; render: (m: M) => React.ReactNode }> = [
    {
      label: "Profit", goal: k(goal),
      help: "Total income minus total expenses, exactly as each month's tab in the Financing sheet says (income = retainers + per-appointment fees + lead deposits).",
      render: (m) => cell(m, m.profit != null ? m.profit >= goal : null, k(m.profit), undefined, m.income != null ? `${usd(m.income)} income − ${usd(m.expense)} expenses` : undefined),
    },
    {
      label: "Clients who stopped paying", goal: `${t.lostMax} or fewer`,
      help: "Paid the month before, but no payment this month. A client who skipped a month also shows here.",
      render: (m) => cell(m, m.lostClients != null ? m.lostClients <= t.lostMax : null, m.lostClients == null ? "—" : String(m.lostClients),
        m.lostList.length ? () => open({ title: `Stopped paying in ${m.label}`, note: "Paid the month before, no payment row this month.", items: m.lostList.map((n) => ({ left: n })) }) : undefined),
    },
    {
      label: "New clients", sub: true, goal: "",
      help: "First payment ever (first month their name shows a payment in the Financing sheet).",
      render: (m) => cell(m, null, `+${m.newClients}`,
        m.newList.length ? () => open({ title: `New clients in ${m.label}`, items: m.newList.map((n) => ({ left: n })) }) : undefined),
    },
    {
      label: "Clients who paid", sub: true, goal: "",
      help: `Clients with a payment that month. Live on the Clients sheet today: ${liveCount ?? "?"}. Click to see Live clients with NO payment row that month (some are just spelled differently in the sheet).`,
      render: (m) => cell(m, null, m.liveNotPaying ? `${m.payingClients} (${m.liveNotPaying.length} Live not paid)` : String(m.payingClients),
        m.liveNotPaying?.length ? () => open({
          title: `Live clients with no payment in ${m.label}`,
          note: "Live on the Clients sheet today, but no payment row under their name or business that month. Some are spelling differences or pay-per-appointment clients with no shows — check, don't assume.",
          items: m.liveNotPaying!.map((x) => ({ left: `${x.name}${x.business ? ` · ${x.business}` : ""}`, right: x.version || "—" })),
        }) : undefined),
    },
    {
      label: "Per-appointment money", goal: `${k(t.ppsMin)}+`,
      help: "Lead deposits we keep (the sheet's 'Deposits From Clients' lines) + per-show fees charged to pay-per-appointment clients.",
      render: (m) => cell(m, m.ppsIncome >= t.ppsMin, k(m.ppsIncome), undefined,
        `${usd(m.ppsDeposits)} deposits kept + ${usd(m.ppsFees)} per-show fees (${m.ppsClients} clients)${m.ppsFeesSquare ? ` · Square charged ${usd(m.ppsFeesSquare)}` : ""}`),
    },
    {
      label: "Retainer clients paying under $500", goal: `${t.under500Max}`,
      help: "Monthly-retainer clients whose total payment that month was under $500. Pay-per-appointment clients are left out (they pay per show).",
      render: (m) => cell(m, m.under500 <= t.under500Max, String(m.under500),
        m.under500List.length ? () => open({ title: `Retainer clients under $500 in ${m.label}`, note: "Partners who split one plan (e.g. 30% / 70%) show separately.", items: m.under500List.map((x) => ({ left: x.name, right: usd(x.amount) })) }) : undefined),
    },
    {
      label: "Average retainer payment", sub: true, goal: "",
      help: "What a monthly-retainer client paid that month, on average (setup/first payments included). Pay-per-appointment clients and lead deposits are not in it.",
      render: (m) => cell(m, null, usd(m.avgPerClient)),
    },
    {
      label: "Sales calls: booked → closed", goal: `${t.closesMin}+ closed`,
      help: "Demo calls booked that month (Demos sheet) → how many closed.",
      render: (m) => cell(m, m.demosClosed >= t.closesMin, `${m.demosBooked} → ${m.demosClosed}`, undefined, `${m.demosBooked} booked · ${m.demosShowed} showed · ${m.demosClosed} closed`),
    },
    {
      label: "Sales calls missed", sub: true, goal: `${t.noShowMaxPct}% or less`,
      help: "No-shows + cancellations, as a share of the demo calls booked that month.",
      render: (m) => cell(m, m.noShowPct != null ? m.noShowPct <= t.noShowMaxPct : null, m.noShowPct == null ? "—" : `${m.noShowPct}%`),
    },
    {
      label: "Ad cost per new client", sub: true, goal: "",
      help: "Our own Facebook ads that month (the 'FB ads' expense in the Financing sheet) ÷ sales calls closed. What it costs us in ads to sign one client.",
      render: (m) => cell(m, null, usd(m.adPerClose), undefined, m.adSpend != null ? `${usd(m.adSpend)} ads ÷ ${m.demosClosed} closed` : undefined),
    },
  ];

  return (
    <div className="rounded-xl border border-[#cfe3f7] bg-white p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-[#1f3559]">🎯 Road to $100k/month profit</h2>
        {last && <span className="text-xs text-[#697a91]">{last.label} profit <b className="text-[#1f3559]">{k(last.profit)}</b> · <b className="text-[#b91c1c]">{k(goal - (last.profit ?? 0))}</b> to go</span>}
      </div>
      <div className="h-2.5 rounded-full bg-[#eef3f8] overflow-hidden">
        <div className="h-full rounded-full bg-[#15B7AE]" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-[11px] text-[#697a91]">
        <span className="inline-block px-1.5 rounded bg-[#e7f6ec] text-[#15803d] font-semibold">green</span> hit the goal ·{" "}
        <span className="inline-block px-1.5 rounded bg-[#fde8ee] text-[#b91c1c] font-semibold">red</span> missed it · hover a row name for what it means · click an <span className="underline decoration-dotted">underlined</span> number to see the names.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-[#8595a8]">
              <th className="px-2 py-1 text-left font-medium">What</th>
              <th className="px-2 py-1 text-center font-medium">Goal</th>
              {shown.map((m) => <th key={m.ym} className="px-2 py-1 text-center font-medium">{m.label.slice(0, 3)}{m.partial ? " (so far)" : ""}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-t border-[#f1f5f9]">
                <td className={cn("px-2 py-1.5 whitespace-nowrap cursor-help", r.sub ? "pl-5 text-[#697a91]" : "font-semibold text-[#1f3559]")} title={r.help}>
                  {r.label} <span className="text-[#a6b3c4]">ⓘ</span>
                </td>
                <td className="px-2 py-1.5 text-center text-[#697a91] whitespace-nowrap">{r.goal}</td>
                {shown.map((m) => r.render(m))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-[#8595a8]">Sources: Financing sheet (profit, payments, deposits, FB ads), Square per-show charges, Demos sheet. The current month is still filling in.</p>

      {panel && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/30 p-4" onClick={() => setPanel(null)}>
          <div className="w-full max-w-md max-h-[75vh] overflow-y-auto rounded-2xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="sticky top-0 bg-white flex items-start justify-between gap-2 px-4 pt-3 pb-2 border-b border-[#eef3f8]">
              <div>
                <p className="text-sm font-bold text-[#1f3559]">{panel.title} · {panel.items.length}</p>
                {panel.note && <p className="text-[11px] text-[#697a91]">{panel.note}</p>}
              </div>
              <button onClick={() => setPanel(null)} aria-label="Close" className="p-1 rounded text-[#8595a8] hover:text-[#1f3559]"><X size={15} /></button>
            </div>
            <ul className="divide-y divide-[#f1f5f9]">
              {panel.items.map((x, i) => (
                <li key={i} className="flex items-center justify-between gap-3 px-4 py-1.5 text-[12px]">
                  <span className="text-[#1f3559] break-words">{x.left}</span>
                  {x.right && <span className="shrink-0 text-[#697a91] tabular-nums">{x.right}</span>}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
