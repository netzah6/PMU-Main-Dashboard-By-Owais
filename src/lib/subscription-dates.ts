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
  return periodKey(sub, sub.next_charge_on);
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
