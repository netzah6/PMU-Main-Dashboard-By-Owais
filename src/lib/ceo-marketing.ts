import type { MonthFinance } from "@/lib/ceo-finance";

/* Marketing tracker (owner, 2026-11-13: "how much we spend, how much we get
   back, the cost per scheduled discovery, the booking percentage for demos,
   and the closing rate for each closer — so we know when to scale the
   budget to bring the new cash").

   One row per month, newest first:
     spend        the agency's own Facebook ads — the "FB ads" expense line
                  on that month's Financing tab (monthly; blank until the
                  owner enters it)
     calls        discovery calls booked — rows on the Discoveries sheet by
                  "Date Sign Up"
     demosBooked  of those calls, how many booked a demo ("Demo Scheduled")
     demos/held/closed  demo calls by the month of the demo (Demos sheet);
                  held = not a no-show or cancellation; closed = status
                  Closed / Deposit Collected with a close date that is not
                  from an older sale (the Sales tab's rule)
     newClients/cash  first-time retainer payers on the Financing tab and
                  what they paid — the same "new cash" as the scorecard
   Per closer: the Demos sheet's "Assigned Person", three windows. */

export type MarketingMonth = {
  ym: string; label: string; partial: boolean;
  spend: number | null;
  calls: number; demosBooked: number; callsMissed: number;
  demos: number; held: number; closed: number;
  newClients: number; cash: number;
  /** Derived: spend ÷ calls, spend ÷ new clients, cash ÷ spend. Null without spend. */
  perCall: number | null; perClient: number | null; ret: number | null;
};
export type CloserRow = { name: string; demos: number; held: number; closed: number; closePct: number | null; upfront: number };
export type Marketing = {
  months: MarketingMonth[];
  closers: { thisMonth: CloserRow[]; lastMonth: CloserRow[]; d90: CloserRow[] };
  labels: { thisMonth: string; lastMonth: string };
  /** The last three finished months with a spend figure, added up. */
  guide: { months: string[]; spend: number; cash: number; newClients: number; ret: number | null; perClient: number | null; firstPay: number | null } | null;
};

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = 86_400_000;

/** "Wednesday, June 3, 2026 13:00" → a Date (noon, local); null otherwise. */
export function spelledDate(raw: unknown): Date | null {
  const m = String(raw ?? "").match(/([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[1].toLowerCase());
  return mi < 0 ? null : new Date(Number(m[3]), mi, Number(m[2]), 12);
}
/** "02/10/2026" (day first, as the sales sheets write it) → a Date; null otherwise. */
export function dayFirstDate(raw: unknown): Date | null {
  const m = String(raw ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 12) : null;
}
const ymOf = (d: Date | null) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` : null);
const money = (v: unknown) => { const n = Number(String(v ?? "").replace(/[^0-9.-]/g, "")); return Number.isFinite(n) ? n : 0; };
const str = (v: unknown) => String(v ?? "").trim();
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : null);
const ratio = (a: number, b: number | null) => (b && b > 0 ? Math.round((a / b) * 10) / 10 : null);
const per = (spend: number | null, n: number) => (spend != null && spend > 0 && n > 0 ? Math.round(spend / n) : null);

type Row = Record<string, unknown>;
type DemoRow = { month: string | null; at: Date | null; closer: string; status: string; won: boolean; upfront: number };

const isNoShow = (s: string) => /no-?show|cancel/i.test(s);
function demoRow(r: Row): DemoRow {
  const at = spelledDate(r["Demo Date"]);
  const status = str(r["Status"]);
  const closeAt = dayFirstDate(r["Close Date"]);
  // A close dated more than 30 days before the demo is an older sale on a reused row.
  const won = /^closed|deposit collected/i.test(status) && !(closeAt && at && closeAt.getTime() < at.getTime() - 30 * DAY);
  return { month: ymOf(at), at, closer: str(r["Assigned Person"]), status, won, upfront: money(r["Upfront Collected"]) };
}

function closerRows(list: DemoRow[]): CloserRow[] {
  const by = new Map<string, CloserRow>();
  for (const d of list) {
    const name = d.closer || "No closer named";
    const row = by.get(name) ?? { name, demos: 0, held: 0, closed: 0, closePct: null, upfront: 0 };
    row.demos++;
    if (!isNoShow(d.status)) row.held++;
    if (d.won) { row.closed++; row.upfront += d.upfront; }
    by.set(name, row);
  }
  return [...by.values()].map((r) => ({ ...r, closePct: pct(r.closed, r.held), upfront: Math.round(r.upfront) }))
    .sort((a, b) => b.closed - a.closed || b.demos - a.demos || a.name.localeCompare(b.name));
}

export function buildMarketingTracker(input: {
  finance: MonthFinance[];
  /** First-time retainer payers per month (the scorecard's closes) and what they paid. */
  closesByYm: Map<string, { count: number; cash: number }>;
  demoRows: Row[];
  discRows: Row[];
  curYm: string;
  monthsBack?: number;
}): Marketing {
  const { finance, closesByYm, curYm } = input;
  const back = input.monthsBack ?? 6;
  const [cy, cm] = curYm.split("-").map(Number);
  const yms: string[] = [];
  for (let i = back; i >= 0; i--) { const d = new Date(Date.UTC(cy, cm - 1 - i, 1)); yms.push(d.toISOString().slice(0, 7)); }
  const label = (ym: string) => `${SHORT[Number(ym.slice(5, 7)) - 1]}${ym.slice(0, 4) !== String(cy) ? ` ${ym.slice(2, 4)}` : ""}`;

  const demos = input.demoRows.map(demoRow);
  const disc = input.discRows.filter((r) => str(r["Full Name"])).map((r) => ({
    month: ymOf(dayFirstDate(r["Date Sign Up"])) ?? ymOf(spelledDate(r["Discovery Date"])),
    status: str(r["Didn't Schedule Demo"] ?? r["Status"]),
  }));

  const months: MarketingMonth[] = yms.map((ym) => {
    const fin = finance.find((m) => m.ym === ym);
    const spend = fin?.adSpend != null && fin.adSpend > 0 ? Math.round(fin.adSpend) : null;
    const calls = disc.filter((d) => d.month === ym);
    const dm = demos.filter((d) => d.month === ym);
    const closed = dm.filter((d) => d.won).length;
    const cl = closesByYm.get(ym) ?? { count: 0, cash: 0 };
    return {
      ym, label: label(ym), partial: ym >= curYm, spend,
      calls: calls.length,
      demosBooked: calls.filter((c) => /demo scheduled/i.test(c.status)).length,
      callsMissed: calls.filter((c) => isNoShow(c.status)).length,
      demos: dm.length, held: dm.filter((d) => !isNoShow(d.status)).length, closed,
      newClients: cl.count, cash: Math.round(cl.cash),
      perCall: per(spend, calls.length), perClient: per(spend, cl.count), ret: ratio(cl.cash, spend),
    };
  }).reverse();

  const lastYm = yms[yms.length - 2];
  const now = new Date();
  const since90 = now.getTime() - 90 * DAY;
  const closers = {
    thisMonth: closerRows(demos.filter((d) => d.month === curYm)),
    lastMonth: closerRows(demos.filter((d) => d.month === lastYm)),
    d90: closerRows(demos.filter((d) => d.at && d.at.getTime() >= since90 && d.at.getTime() <= now.getTime())),
  };

  // The last three finished months that have a spend figure.
  const done = months.filter((m) => !m.partial && m.spend != null).slice(0, 3);
  const guide = done.length ? (() => {
    const spend = done.reduce((t, m) => t + (m.spend ?? 0), 0);
    const cash = done.reduce((t, m) => t + m.cash, 0);
    const newClients = done.reduce((t, m) => t + m.newClients, 0);
    return { months: done.map((m) => m.label), spend, cash, newClients, ret: ratio(cash, spend), perClient: per(spend, newClients), firstPay: newClients ? Math.round(cash / newClients) : null };
  })() : null;

  return { months, closers, labels: { thisMonth: label(curYm), lastMonth: label(lastYm) }, guide };
}
