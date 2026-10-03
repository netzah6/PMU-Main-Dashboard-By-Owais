import { createServiceClient } from "@/lib/supabase/server";
import { getAgencyFinance, type MonthFinance } from "@/lib/ceo-finance";

/* "Road to $100k/mo profit" (owner, 2026-10-03). One row per month with the
   four levers that close the gap from ~$60k:
     1. churn          — clients lost (paid last month, not this month)
     2. PPS money      — lead deposits kept + per-show fees (pay-per-appointment)
     3. price floor    — clients paying under $500 / month
     4. sales          — demos booked → showed → closed, and ad $ per close
   Sources: the Financing workbook (profit, payers, deposits, FB ads),
   ppa_charges (per-show fees), sales_demos (the Demos sheet mirror). */

export const PROFIT_GOAL = 100_000;
export const TARGETS = { lostMax: 12, ppsMin: 32_000, under500Max: 0, noShowMaxPct: 15, closesMin: 16 } as const;

export type GrowthMonth = {
  ym: string; label: string; partial: boolean;
  profit: number | null; income: number | null; expense: number | null;
  payingClients: number; newClients: number; lostClients: number | null;
  under500: number; avgPerClient: number | null;
  ppsDeposits: number; ppsFees: number; ppsIncome: number;
  /** Per-show fees Square actually charged that month (cross-check for ppsFees). */
  ppsFeesSquare: number;
  ppsClients: number;
  newList: string[]; lostList: string[];
  under500List: Array<{ name: string; amount: number }>;
  /** Live on Clients Master today but no payment row this month (name-matched). */
  liveNotPaying: Array<{ name: string; business: string; version: string }> | null;
  demosBooked: number; demosShowed: number; demosClosed: number; noShowPct: number | null;
  adSpend: number | null; adPerClose: number | null;
};

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const nk = (s: unknown) => String(s ?? "").toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

/* Live clients (Clients Master, today) with no payment row in a month.
   Matched by owner or business name, or the owner's first two words inside a
   payer's name — the sheet writes "Hang Le (Sydney)" or the business. Some of
   these are spelling differences, so the list is for checking, not a verdict. */
function liveWithoutPayment(live: Array<Record<string, unknown>>, payerNames: string[]) {
  const keys = payerNames.map(nk);
  const has = (k: string) => !!k && keys.some((p) => p === k || p.includes(k) || k.includes(p));
  return live.filter((d) => {
    const owner = nk(d["Owner Full Name"]);
    const biz = nk(d["Business Name"]);
    const two = owner.split(" ").filter((w) => w.length > 1).slice(0, 2);
    if (has(owner) || (biz.length > 4 && has(biz))) return false;
    if (two.length === 2 && keys.some((p) => two.every((w) => p.split(" ").includes(w)))) return false;
    return true;
  }).map((d) => ({ name: String(d["Owner Full Name"] ?? "").trim(), business: String(d["Business Name"] ?? "").trim(), version: String(d["Version"] ?? "").replace(/[()]/g, "").trim() }));
}

export async function getRoadTo100k(): Promise<{ months: GrowthMonth[]; liveCount: number; error?: string }> {
  const fin = await getAgencyFinance();
  if (fin.error) return { months: [], liveCount: 0, error: fin.error };
  const svc = createServiceClient();

  const live: Array<Record<string, unknown>> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await svc.from("clients_master").select("data").range(off, off + 999);
    if (error) break;
    for (const r of (data ?? []) as Array<{ data: Record<string, unknown> }>) {
      if (/^live$/i.test(String(r.data?.["col_1"] ?? "").trim())) live.push(r.data);
    }
    if (!data || data.length < 1000) break;
  }

  // Per-show fees by month (Square, the Monday PPS run).
  const fees = new Map<string, number>();
  const ppsOwners = new Set<string>(); // anyone Square ever billed per show
  for (let off = 0; ; off += 1000) {
    const { data, error } = await svc.from("ppa_charges").select("amount, charged_at, owner_key")
      .eq("charged", true).not("charged_at", "is", null).or("excluded.is.null,excluded.eq.false")
      .range(off, off + 999);
    if (error) break;
    for (const r of (data ?? []) as Array<{ amount: number | null; charged_at: string; owner_key: string | null }>) {
      if (r.owner_key) ppsOwners.add(nk(r.owner_key));
      const ym = r.charged_at.slice(0, 7);
      fees.set(ym, (fees.get(ym) ?? 0) + Number(r.amount ?? 0));
    }
    if (!data || data.length < 1000) break;
  }

  // Demos by the month of the demo itself ("Wednesday, June 3, 2026 13:00").
  const demos = new Map<string, { booked: number; showed: number; closed: number; noShow: number }>();
  for (let off = 0; ; off += 1000) {
    const { data, error } = await svc.from("sales_demos").select("data").range(off, off + 999);
    if (error) break;
    for (const r of (data ?? []) as Array<{ data: Record<string, unknown> }>) {
      const raw = String(r.data?.["Demo Date"] ?? "");
      const m = raw.match(/([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
      if (!m) continue;
      const mi = MONTH_NAMES.indexOf(m[1].toLowerCase());
      if (mi < 0) continue;
      const ym = `${m[3]}-${String(mi + 1).padStart(2, "0")}`;
      const st = String(r.data?.["Status"] ?? "").trim();
      const d = demos.get(ym) ?? { booked: 0, showed: 0, closed: 0, noShow: 0 };
      d.booked++;
      if (/no-?show|cancel/i.test(st)) d.noShow++;
      else if (st) d.showed++;
      if (/^closed$|deposit collected/i.test(st)) d.closed++;
      demos.set(ym, d);
    }
    if (!data || data.length < 1000) break;
  }

  const nowYm = new Date().toISOString().slice(0, 7);
  const kept = fin.months.filter((m: MonthFinance) => m.ym >= "2026-04"); // the new sheet layout (profit on the tab)
  // "Live but not paying" only makes sense against today's Live list, so it
  // is worked out for the last full month and the current one.
  const recent = new Set(kept.slice(-2).map((m) => m.ym));
  const months: GrowthMonth[] = kept
    .map((m: MonthFinance) => {
      const d = demos.get(m.ym) ?? { booked: 0, showed: 0, closed: 0, noShow: 0 };
      // Per-show fees as the Financing sheet books them (same source as the
      // profit line); Square's own total is kept alongside as a cross-check.
      // Pay-per-appointment = the sheet note says so, OR Square bills them per
      // show (Vanessa Pak, Eric Collazo… have no "per show" note).
      const isPps = (p: { name: string; pps: boolean }) => {
        if (p.pps) return true;
        const k = nk(p.name);
        const two = k.split(" ").slice(0, 2);
        return [...ppsOwners].some((o) => o === k || (two.length === 2 && two.every((w) => o.split(" ").includes(w))));
      };
      const pps = m.payers.filter(isPps);
      const retainers = m.payers.filter((p) => !isPps(p));
      const ppsFeesSheet = Math.round(pps.reduce((t, p) => t + p.amount, 0));
      const ppsFeesSquare = Math.round(fees.get(m.ym) ?? 0);
      // The PPS line uses what Square actually charged when it has it (the
      // sheet books only part of it); before the Square runs, the sheet's rows.
      const ppsFees = ppsFeesSquare || ppsFeesSheet;

      return {
        ym: m.ym, label: m.label, partial: m.ym >= nowYm,
        profit: m.totalProfit, income: m.totalIncome, expense: m.totalExpense,
        payingClients: m.payingClients, newClients: m.firstTimePayers.length, lostClients: m.lostClients,
        under500: retainers.filter((p) => p.amount < 500).length,
        // What one RETAINER client paid this month, on average (their rows that
        // month; pay-per-appointment clients are left out — they pay per show).
        avgPerClient: retainers.length ? Math.round(retainers.reduce((t, p) => t + p.amount, 0) / retainers.length) : null,
        ppsDeposits: Math.round(m.depositIncome), ppsFees, ppsIncome: Math.round(m.depositIncome) + ppsFees,
        ppsFeesSquare,
        ppsClients: pps.length,
        newList: m.firstTimePayers, lostList: m.lostNames,
        under500List: retainers.filter((p) => p.amount < 500).map((p) => ({ name: p.name, amount: Math.round(p.amount) })),
        liveNotPaying: recent.has(m.ym) ? liveWithoutPayment(live, m.payers.map((p) => p.name)) : null,
        demosBooked: d.booked, demosShowed: d.showed, demosClosed: d.closed,
        // No-shows + cancellations as a share of all demos booked that month.
        noShowPct: d.booked ? Math.round((d.noShow / d.booked) * 100) : null,
        adSpend: m.adSpend, adPerClose: m.adSpend != null && d.closed ? Math.round(m.adSpend / d.closed) : null,
      };
    });
  return { months, liveCount: live.length };
}
