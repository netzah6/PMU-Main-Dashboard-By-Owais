"use client";
import { formatCurrency } from "@/lib/utils";
import { bizKey, monthLabel, sortedKey } from "@/lib/ltv-keys";
import type { ClientMoney } from "@/lib/ltv-deposits";
import type { FeeMonth } from "@/lib/worth-recent";

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
        <span className="text-[11px] text-[#8595a8]">{w ? `${n} clients · only you see this · each client’s last 6 months is in the 💰 column` : "loading…"}</span>
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

/* One client per month = the last 6 full months (owner, 11/28/2026).
   Service fees come from Payment Check (the money that really moved in
   Square + dashboard charges, minus refunds/chargebacks), one entry per
   month she was on the Financing sheet; deposits from the deposits list.
   (fees + deposits − refunds) ÷ her months on the sheet. */
const monthNum = (m: string) => { const [y, mo] = m.split("-").map(Number); return y * 12 + mo - 1; };
const CAT: Partial<Record<FeeMonth["cat"], string>> = {
  upfront: "paid upfront earlier", inactive: "paused", pps_none: "no appointments", late: "not paid", norecord: "not paid",
  declined: "card declined", later: "not paid", noamount: "no amount set",
};
export function clientPerMonth(c: ClientMoney | undefined, fees: FeeMonth[]) {
  const rows = fees.map((f) => {
    const d = c?.recent?.byMonth.find((x) => x.m === monthNum(f.m));
    return { m: f.m, fee: f.cents / 100, dep: d?.dep ?? 0, cat: f.cat };
  });
  const months = rows.length;
  const fee = rows.reduce((t, x) => t + x.fee, 0);
  const dep = rows.reduce((t, x) => t + x.dep, 0);
  const refunds = c?.recent?.refunds ?? 0;
  return { rows, months, fee, dep, refunds, perMonth: months ? (fee + dep - refunds) / months : 0 };
}

export function WorthCell({ c, fees, loading, failed }: { c?: ClientMoney; fees?: FeeMonth[]; loading: boolean; failed?: boolean }) {
  if (loading) return <span className="text-[#c3cdd9]" title="Reading the last 6 months of payments…">…</span>;
  if (failed) return <span className="text-[#c3cdd9]" title="Couldn't read the payments. Reload the page to try again.">?</span>;
  if (!fees?.length) return <span className="text-[#c3cdd9]" title="Not on the payment sheet in the last 6 months">—</span>;
  const { rows, months, fee, dep, refunds, perMonth } = clientPerMonth(c, fees);
  const isNew = months < 6;
  const tone = perMonth >= 400 ? "text-[#0e8f88]" : perMonth >= 200 ? "text-[#d97706]" : "text-[#e11d48]";
  const zero = rows.filter((x) => !x.fee);
  const label = (m: string) => monthLabel(monthNum(m));
  const tip = [
    `${c?.name ?? "This client"}: ${formatCurrency(perMonth)} per month (last ${months} month${months === 1 ? "" : "s"})`,
    ...rows.map((x) => `${label(x.m)}: ${formatCurrency(x.fee)}${x.dep ? ` + ${formatCurrency(x.dep)} deposits` : ""}${!x.fee && CAT[x.cat] ? ` (${CAT[x.cat]})` : ""}`),
    `Total: fees ${formatCurrency(fee)} + deposits ${formatCurrency(dep)}${refunds ? ` − refunds ${formatCurrency(refunds)}` : ""} = ${formatCurrency(fee + dep - refunds)}`,
    "Fees = money that really came in (Square + dashboard charges), same as Payment Check.",
    isNew ? `On the payment sheet only ${months} of the last 6 months, so divided by ${months}.` : "",
  ].filter(Boolean).join("\n");
  return (
    <span className="inline-flex flex-col items-start leading-tight cursor-default" title={tip}>
      <span className={`text-xs font-bold ${tone}`}>{formatCurrency(perMonth)}{zero.length ? " ⚠" : ""}</span>
      <span className="text-[10px] text-[#8595a8]">{isNew ? `${months} mo` : "last 6 mo"}</span>
    </span>
  );
}
