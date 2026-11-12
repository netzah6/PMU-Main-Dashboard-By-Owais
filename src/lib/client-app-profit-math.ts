/* Profit maths for the client app — pure, no server imports, so the phone
   screen and the server count the same way.

   Owner, 11/12/2026: she first fills in what EACH client paid her (every
   client who came in through us, old ones too) — "one value for the initial
   treatment and one value for the touch up. As long as there is one value on
   each client… they will be able to continue". Only then her costs; only
   then the profit. So revenue counts the amounts she typed — a client with no
   amount yet counts as nothing and is shown as "to add".

   Costs: every month (rent, insurance…), per client (some artists pay rent
   per appointment — counted once for each client that month), or one time. */

export type ProfitClient = { ref: string; name: string; date: string | null; month: string | null };
/** What one client paid her: the first treatment and the touch-up. One of the two is enough. */
export type ClientPay = { first: number | null; touchup: number | null };
/** The client's total, or null while she hasn't typed anything for her. */
export const paidOf = (p: ClientPay | null | undefined): number | null =>
  p && (p.first != null || p.touchup != null) ? (p.first ?? 0) + (p.touchup ?? 0) : null;
/* What happened with the client (owner, 11/12/2026: "let them update their
   status like if she didn't show up, showed up but didn't move forward").
   "done" is the normal case and needs her amounts. Any other status means she
   earned nothing from that client, so no amount is asked and it counts as $0.
   Her own note only — it never changes her bill. */
export type ClientStatus = "done" | "no_go" | "no_show" | "rescheduled" | "cancelled";
export const STATUS_LABEL: Record<ClientStatus, string> = {
  done: "Treatment done",
  no_go: "Showed up, didn't move forward",
  no_show: "Didn't show up",
  rescheduled: "Rescheduled",
  cancelled: "Cancelled",
};
export const STATUSES = Object.keys(STATUS_LABEL) as ClientStatus[];
export type ExpenseKind = "monthly" | "per_client" | "once";
export type ProfitExpense = {
  id: string; label: string; amount: number;
  kind: ExpenseKind;
  /** "YYYY-MM": the month of a one-time cost, or the first month of a repeating one. */
  month: string;
  /** A repeating cost she stopped: it no longer counts from this month on. */
  endMonth: string | null;
};
export type ProfitData = {
  /** Her usual prices — only a helper to fill amounts in faster. */
  session: number | null; touchup: number | null;
  clients: ProfitClient[];
  /** What each client paid her (ref → treatment + touch-up). */
  amounts: Record<string, ClientPay>;
  /** Only the clients whose status is NOT "done" (ref → status). */
  statuses: Record<string, ClientStatus>;
  expenses: ProfitExpense[];
  thisMonth: string;
  /** The first month a client came in (repeating costs added in set-up count from here). */
  firstMonth: string;
  /** 1 = fill in her clients, 2 = add her costs, 3 = set-up done, show the profit. */
  step: 1 | 2 | 3;
};

const TZ = "America/New_York"; // one clock for "which month" — her clients are in the US
/** "2026-11" for a date; a plain day ("2026-11-08") is taken as written. */
export function monthOf(iso: string | null | undefined): string | null {
  const s = String(iso ?? "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.slice(0, 7);
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).formatToParts(d);
  return `${p.find((x) => x.type === "year")?.value}-${p.find((x) => x.type === "month")?.value}`;
}
export const monthName = (m: string, long = false) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, 15)).toLocaleDateString("en-US", long ? { month: "long", year: "numeric", timeZone: "UTC" } : { month: "long", timeZone: "UTC" });
};
export const shiftMonth = (m: string, by: number) => {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + by, 15));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

export const usualOf = (d: Pick<ProfitData, "session" | "touchup">) => (d.session ?? 0) + (d.touchup ?? 0);
export const expenseInMonth = (e: ProfitExpense, m: string) =>
  e.kind === "once" ? e.month === m : e.month <= m && (!e.endMonth || m < e.endMonth);
export const KIND_LABEL: Record<ExpenseKind, string> = { monthly: "Every month", per_client: "Per client", once: "One time" };

export const statusOf = (d: Pick<ProfitData, "statuses">, ref: string): ClientStatus => d.statuses[ref] ?? "done";
/** What she earned from a client: her amounts; $0 when the treatment didn't happen; null = still to add. */
export const earnedOf = (d: Pick<ProfitData, "statuses" | "amounts">, ref: string): number | null =>
  statusOf(d, ref) !== "done" ? 0 : paidOf(d.amounts[ref]);

export function profitFor(d: ProfitData, m: string) {
  const clients = d.clients.filter((c) => c.month === m)
    .map((c) => ({ ...c, status: statusOf(d, c.ref), pay: d.amounts[c.ref] ?? null, amount: earnedOf(d, c.ref) }));
  // "Per client" costs (rent per appointment) count the clients who really came in.
  const came = clients.filter((c) => c.status === "done" || c.status === "no_go").length;
  const expenses = d.expenses.filter((e) => expenseInMonth(e, m))
    .map((e) => ({ ...e, cost: e.kind === "per_client" ? e.amount * came : e.amount }));
  const revenue = clients.reduce((n, c) => n + (c.amount ?? 0), 0);
  const spent = expenses.reduce((n, e) => n + e.cost, 0);
  return { clients, came, expenses, revenue, spent, profit: revenue - spent, toAdd: clients.filter((c) => c.amount == null).length };
}
/* Everything since her first month with us (owner, 11/12/2026: "see all the
   profits at the top"): the total, and each month for the small chart. */
export function profitAll(d: ProfitData) {
  const months: Array<{ month: string; profit: number; revenue: number; spent: number; clients: number }> = [];
  for (let m = d.firstMonth, i = 0; m <= d.thisMonth && i < 60; m = shiftMonth(m, 1), i++) {
    const p = profitFor(d, m);
    months.push({ month: m, profit: p.profit, revenue: p.revenue, spent: p.spent, clients: p.clients.filter((c) => c.status === "done").length });
  }
  const sum = (f: (x: (typeof months)[number]) => number) => months.reduce((n, x) => n + f(x), 0);
  const best = months.reduce<(typeof months)[number] | null>((b, x) => (x.profit > 0 && (!b || x.profit > b.profit) ? x : b), null);
  return { months, profit: sum((x) => x.profit), revenue: sum((x) => x.revenue), spent: sum((x) => x.spent), clients: sum((x) => x.clients), best };
}

/** Clients, in any month, still waiting for an amount. */
export const clientsToAdd = (d: ProfitData) => d.clients.filter((c) => earnedOf(d, c.ref) == null).length;
