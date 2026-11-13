"use client";
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { Marketing, MarketingMonth } from "@/lib/ceo-marketing";

/* Marketing tracker on the CEO tab (owner, 2026-11-13): spend → calls →
   demos → clients → cash back, one row per month; the closers underneath.
   Numbers only — the words live in the column headers and one footnote. */

const usd = (n: number | null | undefined) => (n == null ? "—" : `$${Math.round(n).toLocaleString("en-US")}`);
const x = (n: number | null) => (n == null ? "—" : `${n.toFixed(1)}x`);
const pc = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

const TH = "text-[11px] uppercase tracking-wide text-[#8595a8] font-semibold py-1.5 px-2 text-right whitespace-nowrap";
const TD = "py-1.5 px-2 text-right tabular-nums text-[13px] text-[#1f3559] whitespace-nowrap";
const SUB = "block text-[10px] font-normal text-[#8595a8]";

function Row({ m }: { m: MarketingMonth }) {
  const dim = m.partial ? "text-[#697a91]" : "";
  return (
    <tr className={cn("border-t border-[#f1f5f9]", m.partial && "bg-[#f8fafc]")}>
      <td className={cn("py-1.5 px-2 text-left text-[13px] font-semibold text-[#1f3559] whitespace-nowrap")}>
        {m.label}{m.partial && <span className={SUB}>so far</span>}
      </td>
      <td className={cn(TD, dim)} title={m.spend == null ? "No \"FB ads\" line on this month's Financing tab yet" : "The \"FB ads\" expense on the Financing tab"}>
        {usd(m.spend)}{m.spend == null && <span className={SUB}>not on the sheet</span>}
      </td>
      <td className={cn(TD, dim)}>{m.calls}<span className={SUB}>{m.callsMissed} missed</span></td>
      <td className={cn(TD, dim)}>{usd(m.perCall)}</td>
      <td className={cn(TD, dim)}>{m.demosBooked}<span className={SUB}>{pc(m.demosBooked, m.calls)} of calls</span></td>
      <td className={cn(TD, dim)}>{m.closed}<span className={SUB}>{pc(m.closed, m.held)} of {m.held} held</span></td>
      <td className={cn(TD, dim, "font-semibold text-[#0f8f88]")}>{usd(m.cash)}<span className={SUB}>{m.newClients} new {m.newClients === 1 ? "client" : "clients"}</span></td>
      <td className={cn(TD, dim, m.ret != null && (m.ret >= 1 ? "text-[#15803d] font-semibold" : "text-[#b91c1c] font-semibold"))}>
        {x(m.ret)}<span className={SUB}>{m.perClient == null ? "" : `${usd(m.perClient)} per client`}</span>
      </td>
    </tr>
  );
}

export function MarketingTracker({ m }: { m: Marketing }) {
  const [win, setWin] = useState<"thisMonth" | "lastMonth" | "d90">("d90");
  const rows = m.closers[win];
  const g = m.guide;
  return (
    <div className="rounded-xl border border-[#e4ebf2] bg-white p-3 space-y-2.5" style={{ boxShadow: "var(--shadow-sm)" }}>
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-[#1f3559]">📣 Marketing tracker</h2>
        <span className="text-[11px] text-[#8595a8]">our ads → calls → demos → new clients</span>
      </div>

      {g && (
        <p className="text-[12px] text-[#34568a] rounded-lg bg-[#eefaf9] border border-[#bfe6e3] px-3 py-2">
          Last 3 months ({g.months.slice().reverse().join(", ")}): <b>{usd(g.spend)}</b> in ads brought <b>{g.newClients}</b> new clients and <b className="text-[#0f8f88]">{usd(g.cash)}</b> back in first payments
          {g.ret != null && <> (<b>{x(g.ret)}</b>)</>}.
          {g.perClient != null && g.firstPay != null && <> A new client costs <b>{usd(g.perClient)}</b> in ads and pays <b>{usd(g.firstPay)}</b> in month 1.</>}
        </p>
      )}

      <div className="overflow-x-auto -mx-1 px-1">
        <table className="w-full min-w-[640px]">
          <thead>
            <tr>
              <th className={cn(TH, "text-left")}>Month</th>
              <th className={TH}>Ad spend</th>
              <th className={TH}>Calls booked</th>
              <th className={TH}>$ per call</th>
              <th className={TH}>Demos booked</th>
              <th className={TH}>Closed</th>
              <th className={TH}>Cash back</th>
              <th className={TH}>Return</th>
            </tr>
          </thead>
          <tbody>{m.months.map((row) => <Row key={row.ym} m={row} />)}</tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-2 flex-wrap pt-1">
        <h3 className="text-[13px] font-semibold text-[#1f3559]">By closer</h3>
        <div className="flex gap-1">
          {([["thisMonth", m.labels.thisMonth], ["lastMonth", m.labels.lastMonth], ["d90", "90 days"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setWin(k)}
              className={cn("px-2 py-0.5 rounded-full text-[11px] font-semibold border",
                win === k ? "bg-[#0f8f88] text-white border-[#0f8f88]" : "bg-white text-[#0f8f88] border-[#bfe6e3] hover:bg-[#eefaf9]")}>{l}</button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="text-[12px] text-[#8595a8]">No demo calls in this window.</p>
      ) : (
        <table className="w-full">
          <thead>
            <tr>
              <th className={cn(TH, "text-left")}>Closer</th>
              <th className={TH}>Demos</th>
              <th className={TH}>Held</th>
              <th className={TH}>Closed</th>
              <th className={TH}>Close rate</th>
              <th className={TH}>Upfront</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-t border-[#f1f5f9]">
                <td className="py-1.5 px-2 text-left text-[13px] font-semibold text-[#1f3559]">{r.name}</td>
                <td className={TD}>{r.demos}</td>
                <td className={TD}>{r.held}</td>
                <td className={TD}>{r.closed}</td>
                <td className={cn(TD, "font-semibold", r.closePct != null && (r.closePct >= 30 ? "text-[#15803d]" : "text-[#b91c1c]"))}>{r.closePct == null ? "—" : `${r.closePct}%`}</td>
                <td className={cn(TD, "text-[#0f8f88]")}>{usd(r.upfront)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="text-[10px] text-[#8595a8] leading-snug">
        Ad spend = the &ldquo;FB ads&rdquo; line on the month&rsquo;s Financing tab (monthly). Calls = discovery calls booked (Discoveries sheet). Demos and closers = the Demos sheet by demo date; held = not a no-show or cancellation;
        close rate = closed ÷ held, green at 30%+. Cash back = first payments of new retainer clients that month (Financing), so a close that hasn&rsquo;t paid yet counts under Closed but not under Cash back.
      </p>
    </div>
  );
}
