"use client";
import { formatCurrency } from "@/lib/utils";
import { bizKey, monthLabel, monthNow, sortedKey } from "@/lib/ltv-keys";
import type { ClientMoney } from "@/lib/ltv-deposits";

/* 💎 What one client is worth to us on average (owner, 11/27/2026): lifetime
   service fees + the lead deposits we kept (minus refunds), divided by every
   paying client. Admin only — the page shows it only to admins and the data
   route refuses anyone else. Service fees = the LTV sheet + the monthly and
   per-appointment charges the dashboard takes itself. */
export type Worth = {
  clients: number; fees: number; deposits: number; refunds: number; withDeposits: number; months: number;
  perClient: ClientMoney[];
};

export function ClientWorthBox({ w }: { w: Worth | null }) {
  const n = w?.clients || 0;
  const fee = n ? w!.fees / n : 0;
  const dep = n ? Math.max(0, w!.deposits - w!.refunds) / n : 0;
  const perMonth = w?.months ? (w.fees + Math.max(0, w.deposits - w.refunds)) / w.months : 0;
  const stay = n && w ? w.months / n : 0;
  const tile = "rounded-lg border border-black/5 px-3 py-2 text-center";
  return (
    <div className="rounded-[14px] border border-[#e4ebf2] bg-white p-3" style={{ boxShadow: "var(--shadow-sm)" }}>
      <div className="flex items-baseline gap-2 flex-wrap mb-2">
        <span className="text-sm font-semibold text-[#1f3559]">💎 Average client worth</span>
        <span className="text-[11px] text-[#8595a8]">{w ? `${n} clients · only you see this · each client's own number is in the 💰 column` : "loading…"}</span>
      </div>
      <div className="flex items-baseline gap-2 flex-wrap mb-2"
        title="All service fees + deposits (minus refunds), divided by all the months clients stayed with us (first to last month we got money from them).">
        <span className="text-2xl font-bold text-[#0f1b2d]">{w ? formatCurrency(perMonth) : "…"}</span>
        <span className="text-sm text-[#34568a]">per client, per month</span>
        {w && <span className="text-xs text-[#8595a8]">· they stay about {stay.toFixed(1)} months</span>}
      </div>
      <div className="text-[10px] font-bold uppercase tracking-wide text-[#8595a8] mb-1">Whole time with us</div>
      <div className="grid grid-cols-3 gap-2 max-w-xl">
        <div className={tile} style={{ background: "#e6f7f5" }}>
          <p className="text-[10px] font-bold uppercase tracking-wide text-[#1e2a3a]/70">Service fees</p>
          <p className="text-sm font-bold text-[#0e8f88]">{w ? formatCurrency(fee) : "…"}</p>
        </div>
        <div className={tile} style={{ background: "#f5f3ff" }} title={w ? `Deposits ${formatCurrency(w.deposits)} − refunds ${formatCurrency(w.refunds)}, spread over all ${n} clients (${w.withDeposits} had deposits)` : undefined}>
          <p className="text-[10px] font-bold uppercase tracking-wide text-[#1e2a3a]/70">+ Deposits</p>
          <p className="text-sm font-bold text-[#6d28d9]">{w ? formatCurrency(dep) : "…"}</p>
        </div>
        <div className={tile} style={{ background: "#ffe2ad" }}>
          <p className="text-[10px] font-bold uppercase tracking-wide text-[#1e2a3a]/70">= Total per client</p>
          <p className="text-sm font-bold text-[#0f1b2d]">{w ? formatCurrency(fee + dep) : "…"}</p>
        </div>
      </div>
    </div>
  );
}

/* Performance row → its client: business name first, then owner name. */
export function matchWorth(list: ClientMoney[]) {
  const byBiz = new Map<string, ClientMoney>(), byName = new Map<string, ClientMoney>();
  for (const c of list) {
    for (const b of c.bizKeys) if (!byBiz.has(b)) byBiz.set(b, c);
    for (const k of c.nameKeys) if (!byName.has(k)) byName.set(k, c);
  }
  return (business: string | null, owner: string | null, adAccount: string | null): ClientMoney | undefined =>
    byBiz.get(bizKey(business)) ?? byBiz.get(bizKey(adAccount)) ?? byName.get(sortedKey(owner));
}

/* One client per month, from their first month with us to this month:
   (service fees + deposits − refunds) ÷ months. Upfront payments spread over
   the months they cover, because the months run to today. */
export function clientPerMonth(c: ClientMoney) {
  const fees = c.sheetFees + c.monthly + c.perAppt;
  const dep = Math.max(0, c.deposits - c.refunds);
  const months = c.first == null ? 0 : Math.max(1, monthNow() - c.first + 1);
  return { fees, dep, months, perMonth: months ? (fees + dep) / months : 0 };
}

export function WorthCell({ c, loading }: { c?: ClientMoney; loading: boolean }) {
  if (loading) return <span className="text-[#c3cdd9]">…</span>;
  if (!c) return <span className="text-[#c3cdd9]" title="No payments found for this client">—</span>;
  const { fees, dep, months, perMonth } = clientPerMonth(c);
  if (!months) return <span className="text-[#c3cdd9]" title="No payment dates found">—</span>;
  const isNew = months < 3;
  const tone = isNew ? "text-[#8595a8]" : perMonth >= 400 ? "text-[#0e8f88]" : perMonth >= 200 ? "text-[#d97706]" : "text-[#e11d48]";
  const gap = c.feeGap >= 3 && c.gapFrom != null;
  const tip = [
    `${c.name}: ${formatCurrency(perMonth)} per month over ${months} month${months === 1 ? "" : "s"} (since ${monthLabel(c.first!)})`,
    `Service fees ${formatCurrency(fees)}${c.monthly || c.perAppt ? ` (incl. ${c.monthly ? `${formatCurrency(c.monthly)} monthly charges` : ""}${c.monthly && c.perAppt ? " + " : ""}${c.perAppt ? `${formatCurrency(c.perAppt)} per-appointment fees` : ""} taken by the dashboard)` : ""}`,
    `Deposits ${formatCurrency(c.deposits)} − refunds ${formatCurrency(c.refunds)} = ${formatCurrency(dep)}${c.depCount ? ` (${c.depCount} deposits)` : ""}`,
    c.last != null ? `Last money in: ${monthLabel(c.last)}` : "",
    isNew ? "New client (under 3 months): upfront payments make this look high for now." : "",
    gap ? `⚠ No service fee on record for ${c.feeGap} months from ${monthLabel(c.gapFrom!)}. They may have paid somewhere we don't see — check Square before deciding.` : "",
  ].filter(Boolean).join("\n");
  return (
    <span className="inline-flex flex-col items-start leading-tight cursor-default" title={tip}>
      <span className={`text-xs font-bold ${tone}`}>{formatCurrency(perMonth)}{gap && " ⚠"}</span>
      <span className="text-[10px] text-[#8595a8]">{isNew ? "new · " : ""}{months} mo</span>
    </span>
  );
}
