// Date and billing-period rules for dashboard subscriptions, kept free of
// server imports so the Subs tab can show exactly what the server will do.

export type SubDates = {
  cadence: "monthly" | "once";
  charge_day: number | null;
  next_charge_on: string;
  retry_attempt?: number | null;
  retry_period?: string | null;
};

/** The billing period a charge belongs to — the guard against double charges. */
export function periodKey(sub: SubDates, on: string): string {
  return sub.cadence === "monthly" ? on.slice(0, 7) : on;
}

/** Next due date after charging for `on`. "once" subscriptions do not recur. */
export function advance(sub: SubDates, on: string): string | null {
  if (sub.cadence === "once") return null;
  const d = new Date(`${on}T12:00:00Z`);
  const day = sub.charge_day ?? d.getUTCDate();
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, Math.min(day, 28), 12));
  return next.toISOString().slice(0, 10);
}

type LedgerRow = { status: string; period_key: string | null; charged_at: string };

/* The bill that "Mark paid" settles (owner, 2026-10-06: "if I charge it
   manually from Square, mark it as paid so it will not charge it for this
   month"). In order:
     - a retry in progress is still collecting its period;
     - a subscription paused after its retries ran out has forgotten which
       period failed, but the ledger has not: the latest charge failed and that
       period was never paid;
     - otherwise it is the next scheduled bill. */
export function owedPeriod(sub: SubDates, charges: LedgerRow[]): string {
  if ((sub.retry_attempt ?? 0) > 0 && sub.retry_period) return sub.retry_period;
  const newest = [...charges].sort((a, b) => b.charged_at.localeCompare(a.charged_at));
  const last = newest[0];
  if (last && last.status === "failed" && last.period_key
    && !newest.some((c) => c.status === "succeeded" && c.period_key === last.period_key)) {
    return last.period_key;
  }
  // The next scheduled bill — skipping any month already collected (a date
  // moved within a paid month would otherwise offer that month again).
  let on = sub.next_charge_on;
  let p = periodKey(sub, on);
  for (let i = 0; i < 24 && sub.cadence === "monthly"
    && charges.some((c) => c.status === "succeeded" && c.period_key === p); i++) {
    on = advance(sub, on) as string;
    p = periodKey(sub, on);
  }
  return p;
}

/* The earliest moment a Square payment could have been made FOR `period`:
   its first charge attempt if there was one, else up to 10 days before it fell
   due — and never before the last bill that was collected. Keeps last
   month's hand charge from being linked as this month's receipt. */
export function paymentSince(sub: SubDates, period: string, charges: LedgerRow[]): string {
  const attempts = charges.filter((c) => c.period_key === period).map((c) => c.charged_at).sort();
  const day = Math.min(sub.charge_day ?? Number(sub.next_charge_on.slice(8, 10)), 28);
  const due = sub.cadence === "monthly" ? `${period.slice(0, 7)}-${String(day).padStart(2, "0")}` : period.slice(0, 10);
  const from = new Date(`${(attempts[0] ?? due).slice(0, 10)}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - (attempts[0] ? 1 : 10));
  const since = from.getTime();
  const lastPaid = Math.max(0, ...charges.filter((c) => c.status === "succeeded").map((c) => new Date(c.charged_at).getTime()));
  return new Date(Math.max(since, lastPaid)).toISOString();
}

/* The next charge once `period` is paid: the same day of the following
   month. Never earlier than the date already set — settling an old bill must
   not pull the schedule backwards. null = a one-time bill, now done. */
export function nextAfterPaid(sub: SubDates, period: string): string | null {
  if (sub.cadence === "once") return null;
  const day = Math.min(sub.charge_day ?? Number(sub.next_charge_on.slice(8, 10)), 28);
  const next = advance(sub, `${period.slice(0, 7)}-${String(day).padStart(2, "0")}`) as string;
  return next > sub.next_charge_on ? next : sub.next_charge_on;
}
