import { createServiceClient } from "@/lib/supabase/server";
import { buildMonth, listMonthTabs, type Category, type MonthPayload } from "@/lib/payment-check";
import { sortedKey } from "@/lib/ltv-keys";

/* Service fees per client per month, for the Performance "worth" number
   (owner, 11/28/2026: "She pays us $500/mo, don't you see those charges?").

   The LTV payment list only got about half the payments after 04/2026
   (Square's own monthly plans and pay links never reached it), so the last
   6 months now come from Payment Check instead: each month of the Financing
   sheet matched against the money that really moved — Square payments,
   dashboard monthly charges and per-appointment charges, minus refunds and
   chargebacks. Same numbers as the Payment Check tab.

   A finished month is read from payment_check_cache; a month that is missing,
   or was saved before the month ended, is built once and saved again. */

export type FeeMonth = { m: string; cents: number; cat: Category };
export type RecentFees = {
  months: string[];                        // "2026-05" … oldest first
  byKey: Record<string, FeeMonth[]>;       // client name key (any word order) → months she has a row
  warnings: string[];
};

const monthEnd = (month: string) => { const [y, m] = month.split("-").map(Number); return Date.UTC(y, m, 1); };

export async function getRecentFees(count = 6): Promise<RecentFees> {
  const svc = createServiceClient();
  const now = new Date();
  const cur = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const tabs = (await listMonthTabs()).filter((t) => t.month < cur).sort((a, b) => b.month.localeCompare(a.month)).slice(0, count).reverse();
  const { data: cached } = await svc.from("payment_check_cache").select("month, payload, built_at").in("month", tabs.map((t) => t.month));
  const byMonth = new Map((cached ?? []).map((c) => [c.month as string, c as { payload: MonthPayload; built_at: string }]));

  const warnings: string[] = [];
  const byKey: Record<string, FeeMonth[]> = {};
  for (const t of tabs) {
    const c = byMonth.get(t.month);
    // Final once saved at least 2 days after the month ended (late payments land).
    const final = c && new Date(c.built_at).getTime() >= monthEnd(t.month) + 2 * 864e5 && c.payload?.rows?.[0]?.facts;
    let payload = final ? c!.payload : null;
    if (!payload) {
      payload = await buildMonth(svc, t);
      // Only a full match (Square read) is worth saving for the Payment Check tab.
      if (payload.squareChecked) await svc.from("payment_check_cache").upsert({ month: t.month, payload, built_at: payload.builtAt });
    }
    if (!payload.squareChecked) warnings.push(`${t.label}: Square was not checked`);
    for (const r of payload.rows) {
      // "Erin X / Ayesha Y" rows: the whole name and each person point here.
      const keys = new Set([sortedKey(r.name), ...r.name.split("/").map(sortedKey)].filter(Boolean));
      const row: FeeMonth = { m: t.month, cents: r.paidCents, cat: r.category };
      for (const k of keys) {
        const list = (byKey[k] ??= []);
        if (!list.some((x) => x.m === t.month)) list.push(row);
      }
    }
  }
  return { months: tabs.map((t) => t.month), byKey, warnings };
}
