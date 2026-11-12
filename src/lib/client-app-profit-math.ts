/* Profit maths for the client app — pure, no server imports, so the phone
   screen and the server count the same way.

   Owner, 11/12/2026: she first fills in what EACH client paid her (every
   client who came in through us, old ones too); only then her costs; only
   then the profit. So revenue counts the amounts she typed — a client with no
   amount yet counts as nothing and is shown as "to add".

   Costs: every month (rent, insurance…), per client (some artists pay rent
   per appointment — counted once for each client that month), or one time. */

export type ProfitClient = { ref: string; name: string; date: string | null; month: string | null };
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
  /** What each client paid her (ref → dollars). */
  amounts: Record<string, number>;
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

export function profitFor(d: ProfitData, m: string) {
  const clients = d.clients.filter((c) => c.month === m).map((c) => ({ ...c, amount: d.amounts[c.ref] ?? null }));
  const expenses = d.expenses.filter((e) => expenseInMonth(e, m))
    .map((e) => ({ ...e, cost: e.kind === "per_client" ? e.amount * clients.length : e.amount }));
  const revenue = clients.reduce((n, c) => n + (c.amount ?? 0), 0);
  const spent = expenses.reduce((n, e) => n + e.cost, 0);
  return { clients, expenses, revenue, spent, profit: revenue - spent, toAdd: clients.filter((c) => c.amount == null).length };
}
/** Clients, in any month, still waiting for an amount. */
export const clientsToAdd = (d: ProfitData) => d.clients.filter((c) => d.amounts[c.ref] == null).length;
