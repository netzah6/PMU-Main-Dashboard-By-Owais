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
  demosBooked: number; demosShowed: number; demosClosed: number; noShowPct: number | null;
  adSpend: number | null; adPerClose: number | null;
};

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export async function getRoadTo100k(): Promise<{ months: GrowthMonth[]; error?: string }> {
  const fin = await getAgencyFinance();
  if (fin.error) return { months: [], error: fin.error };
  const svc = createServiceClient();

  // Per-show fees by month (Square, the Monday PPS run).
  const fees = new Map<string, number>();
  for (let off = 0; ; off += 1000) {
    const { data, error } = await svc.from("ppa_charges").select("amount, charged_at")
      .eq("charged", true).not("charged_at", "is", null).or("excluded.is.null,excluded.eq.false")
      .range(off, off + 999);
    if (error) break;
    for (const r of (data ?? []) as Array<{ amount: number | null; charged_at: string }>) {
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
  const months: GrowthMonth[] = fin.months
    .filter((m: MonthFinance) => m.ym >= "2026-04") // the new sheet layout (profit on the tab)
    .map((m: MonthFinance) => {
      const d = demos.get(m.ym) ?? { booked: 0, showed: 0, closed: 0, noShow: 0 };
      const ppsFees = Math.round(fees.get(m.ym) ?? 0);

      return {
        ym: m.ym, label: m.label, partial: m.ym >= nowYm,
        profit: m.totalProfit, income: m.totalIncome, expense: m.totalExpense,
        payingClients: m.payingClients, newClients: m.newClients, lostClients: m.lostClients,
        under500: m.under500,
        // What one paying client paid this month, on average (all their rows).
        avgPerClient: m.payingClients ? Math.round((m.newCash + m.recurringCash) / m.payingClients) : null,
        ppsDeposits: Math.round(m.depositIncome), ppsFees, ppsIncome: Math.round(m.depositIncome) + ppsFees,
        demosBooked: d.booked, demosShowed: d.showed, demosClosed: d.closed,
        // No-shows + cancellations as a share of all demos booked that month.
        noShowPct: d.booked ? Math.round((d.noShow / d.booked) * 100) : null,
        adSpend: m.adSpend, adPerClose: m.adSpend != null && d.closed ? Math.round(m.adSpend / d.closed) : null,
      };
    });
  return { months };
}
