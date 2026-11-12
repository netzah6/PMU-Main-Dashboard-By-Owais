/* Profit maths for the client app — pure, no server imports, so the phone
   screen and the server count the same way.

   Revenue for a month = the clients who came in through us that month × what
   a client is worth to her (her session price + her touch-up price), unless
   she typed her own amount for that client. Profit = revenue − the expenses
   she entered for that month. */

export type ProfitClient = { ref: string; name: string; date: string | null; month: string | null };
export type ProfitExpense = {
  id: string; label: string; amount: number;
  kind: "monthly" | "once";
  /** "YYYY-MM": the month of a one-time expense, or the first month of a monthly one. */
  month: string;
  /** A monthly expense she stopped: it no longer counts from this month on. */
  endMonth: string | null;
};
export type ProfitData = {
  session: number | null; touchup: number | null;
  clients: ProfitClient[];
  /** Her own amount for one client (ref → dollars), instead of the usual worth. */
  amounts: Record<string, number>;
  expenses: ProfitExpense[];
  thisMonth: string;
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

export const worthOf = (d: Pick<ProfitData, "session" | "touchup">) => (d.session ?? 0) + (d.touchup ?? 0);
export const expenseInMonth = (e: ProfitExpense, m: string) =>
  e.kind === "once" ? e.month === m : e.month <= m && (!e.endMonth || m < e.endMonth);

export function profitFor(d: ProfitData, m: string) {
  const worth = worthOf(d);
  const clients = d.clients.filter((c) => c.month === m).map((c) => ({ ...c, amount: d.amounts[c.ref] ?? worth, own: d.amounts[c.ref] != null }));
  const expenses = d.expenses.filter((e) => expenseInMonth(e, m));
  const revenue = clients.reduce((n, c) => n + c.amount, 0);
  const spent = expenses.reduce((n, e) => n + e.amount, 0);
  return { worth, clients, expenses, revenue, spent, profit: revenue - spent };
}
