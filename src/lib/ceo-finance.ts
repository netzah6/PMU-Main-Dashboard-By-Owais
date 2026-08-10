import { getSheetsClient } from "@/lib/sheets";

// Agency finance, read straight from the Financing workbook.
//
// This replaces the embedded CEO page, which fetched the same workbook from the
// browser via public gviz links against a HARDCODED month list that stopped at
// May — so June, July and August simply did not exist on it.
//
// The workbook carries two layouts and both are authoritative:
//   Jan / Feb / March   header row 3 — client in col G, amount in col D
//   April V2 … Aug V2   header row 6 — client in col B, amount in col E,
//                       plus Total Income / Expense / Profit already summed on
//                       row 3, which we prefer over re-adding the column.
export const FINANCE_SHEET_ID = "1h0QdmsUVm6Ss8OQWz0yXt6dy5fkXHL2wwQWpjV3_P7A";

type Schema = "old" | "new";

// Tab titles are stable; the "V2" suffix marks the layout change in April.
const MONTHS: { label: string; ym: string; tab: string; schema: Schema }[] = [
  { label: "January",   ym: "2026-01", tab: "Jan",       schema: "old" },
  { label: "February",  ym: "2026-02", tab: "Feb",       schema: "old" },
  { label: "March",     ym: "2026-03", tab: "March",     schema: "old" },
  { label: "April",     ym: "2026-04", tab: "April V2",  schema: "new" },
  { label: "May",       ym: "2026-05", tab: "May V2",    schema: "new" },
  { label: "June",      ym: "2026-06", tab: "June V2",   schema: "new" },
  { label: "July",      ym: "2026-07", tab: "July V2",   schema: "new" },
  { label: "August",    ym: "2026-08", tab: "August V2", schema: "new" },
];

export interface MonthFinance {
  label: string;
  ym: string;
  newClients: number;
  newCash: number;
  recurringClients: number;
  recurringCash: number;
  /** Whop + Fanbasis deposits collected from clients — income, but not a
   *  subscription payment, so it belongs to neither new nor recurring. */
  depositIncome: number;
  totalCash: number;
  /** Straight from the tab's own summary row; null on the old layout. */
  totalIncome: number | null;
  totalExpense: number | null;
  totalProfit: number | null;
  newNames: string[];
}

export interface FinanceResult {
  months: MonthFinance[];
  generatedAt: string;
  error?: string;
}

/** Join key for "have we billed this person before?" — tolerant of the
 *  parenthetical aliases the sheet uses ("Hang Le (Sydney)"). */
function nameKey(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function money(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

// Rows in the client column that aren't clients: section labels, the aggregate
// deposit lines, and stray totals that land in the same column.
const NOT_A_CLIENT = /deposits from clients|^total|^client name$|^customer$|^\s*\$/i;

export async function getAgencyFinance(): Promise<FinanceResult> {
  try {
    const sheets = await getSheetsClient();
    const ranges = MONTHS.map((m) => `'${m.tab}'!A1:H400`);
    const res = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: FINANCE_SHEET_ID,
      ranges,
      valueRenderOption: "FORMATTED_VALUE",
    });
    const valueRanges = res.data.valueRanges ?? [];

    // A client counts as NEW the first month their name ever appears, and as
    // recurring every month after — so the set carries across the whole year.
    const seen = new Set<string>();
    const months: MonthFinance[] = [];

    MONTHS.forEach((m, i) => {
      const rows = (valueRanges[i]?.values ?? []) as string[][];
      const nameIdx = m.schema === "old" ? 6 : 1;
      const amtIdx = m.schema === "old" ? 3 : 4;

      let newClients = 0, newCash = 0, recurringClients = 0, recurringCash = 0;
      let depositIncome = 0;
      const newNames: string[] = [];

      for (const row of rows) {
        const raw = String(row?.[nameIdx] ?? "").trim();
        // Deposit lines are real income and are what makes the month tie to the
        // sheet's own Total Income — they just aren't a client subscription.
        if (/deposits from clients/i.test(raw)) {
          depositIncome += money(row?.[amtIdx]);
          continue;
        }
        if (!raw || NOT_A_CLIENT.test(raw)) continue;
        const key = nameKey(raw);
        if (key.length < 3) continue;
        const amt = money(row?.[amtIdx]);
        if (seen.has(key)) {
          recurringClients++;
          recurringCash += amt;
        } else {
          seen.add(key);
          newClients++;
          newCash += amt;
          newNames.push(raw);
        }
      }

      // New layout sums itself on row 3 (B/C/D). Trust the sheet's own figures
      // over our re-addition where they exist.
      const summary = m.schema === "new" ? (rows[2] ?? []) : [];
      const totalIncome = m.schema === "new" ? money(summary[1]) || null : null;
      const totalExpense = m.schema === "new" ? money(summary[2]) || null : null;
      const totalProfit = m.schema === "new" ? money(summary[3]) || null : null;

      months.push({
        label: m.label, ym: m.ym,
        newClients, newCash, recurringClients, recurringCash, depositIncome,
        totalCash: newCash + recurringCash + depositIncome,
        totalIncome, totalExpense, totalProfit,
        newNames,
      });
    });

    return { months, generatedAt: new Date().toISOString() };
  } catch (err) {
    return { months: [], generatedAt: new Date().toISOString(), error: String(err) };
  }
}

// ── Upfront collected & closes ──────────────────────────────────────────────
//
// Sources, confirmed against the live workbooks:
//   Closes + upfront -> Cash workbook, tab "Demos (unique entries)" (gid
//                       1137757254): Full Name, Status, Assigned Person,
//                       Close Date, Upfront Collected.
//   Expected LTV     -> LTV workbook, Sheet2!E4 ("Real LTV - $250 & Deposits").
//
// Ad spend is deliberately absent. The embedded page filtered the Facebook
// Campaign Stats workbook for a campaign called "PMU Conversions - New", which
// does not exist in it — that workbook holds CLIENT campaigns only, and zero
// rows match. That is why the old card showed $0 spend and ROI +0%. Rather than
// reproduce a broken number, ROI is left out until the agency's own ad spend has
// a real source.
export const CASH_SHEET_ID = "11lqrr8C-GdrqAhMJ5cNU9lRMfFP3dqyJQle2pxaMH9s";
const DEMOS_TAB = "Demos (unique entries)";

export interface Close {
  name: string;
  closedOn: string;   // ISO date
  upfront: number;
  assignedTo: string;
}

export interface Window {
  key: "month" | "d14" | "d30";
  label: string;
  closes: Close[];
  closeCount: number;
  upfrontTotal: number;
  expectedLtv: number;
  /** True when the window is built from payments rather than close dates. */
  fromPayments?: boolean;
}

export interface UpfrontResult {
  windows: Window[];
  avgLtv: number;
  /** Rows marked Closed in the Demos tab with no Close Date — invisible to the
   *  rolling windows, so the count is surfaced instead of silently dropped. */
  undatedClosed: number;
  generatedAt: string;
  error?: string;
}

/** First-time payers in one month, straight from the Financing workbook —
 *  the sheet Square payments actually land in. */
async function newPayersForMonth(ym: string): Promise<{ name: string; amount: number }[]> {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: FINANCE_SHEET_ID,
    ranges: MONTHS.map((m) => `'${m.tab}'!A1:H400`),
    valueRenderOption: "FORMATTED_VALUE",
  });
  const seen = new Set<string>();
  const out: { name: string; amount: number }[] = [];
  MONTHS.forEach((m, i) => {
    const rows = (res.data.valueRanges?.[i]?.values ?? []) as string[][];
    const nameIdx = m.schema === "old" ? 6 : 1;
    const amtIdx = m.schema === "old" ? 3 : 4;
    for (const r of rows) {
      const raw = String(r?.[nameIdx] ?? "").trim();
      if (!raw || NOT_A_CLIENT.test(raw) || /deposits from clients/i.test(raw)) continue;
      const k = nameKey(raw);
      if (k.length < 3 || seen.has(k)) continue;
      seen.add(k);
      if (m.ym === ym) out.push({ name: raw, amount: money(r?.[amtIdx]) });
    }
  });
  return out;
}

/** "01/03/2022" (DD/MM/YYYY) or a long-form date -> UTC Date, else null. */
function parseCloseDate(raw: string): Date | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** name key -> earliest "YYYY-MM" that name appears in the Financing workbook. */
async function firstBillingMonth(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: FINANCE_SHEET_ID,
      ranges: MONTHS.map((m) => `'${m.tab}'!A1:H400`),
      valueRenderOption: "FORMATTED_VALUE",
    });
    MONTHS.forEach((m, i) => {
      const rows = (res.data.valueRanges?.[i]?.values ?? []) as string[][];
      const nameIdx = m.schema === "old" ? 6 : 1;
      for (const r of rows) {
        const raw = String(r?.[nameIdx] ?? "").trim();
        if (!raw || NOT_A_CLIENT.test(raw) || /deposits from clients/i.test(raw)) continue;
        const k = nameKey(raw);
        if (k.length < 3) continue;
        if (!out.has(k)) out.set(k, m.ym);
      }
    });
  } catch { /* if the workbook is unreadable, treat every close as new */ }
  return out;
}

export async function getUpfrontAndCloses(ym?: string): Promise<UpfrontResult> {
  try {
    const sheets = await getSheetsClient();
    const [demos, ltv] = await Promise.all([
      sheets.spreadsheets.values.get({
        spreadsheetId: CASH_SHEET_ID,
        range: `'${DEMOS_TAB}'!A1:J4000`,
        valueRenderOption: "FORMATTED_VALUE",
      }),
      sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SHEET2_ID!,
        range: "'Sheet2'!E4",
        valueRenderOption: "FORMATTED_VALUE",
      }),
    ]);

    const avgLtv = money(ltv.data.values?.[0]?.[0]);
    const rows = (demos.data.values ?? []) as string[][];

    // Header row 1: Date | Full Name | Status | Assigned Person | | Discovery
    // Date | | Demo Date | Close Date | Upfront Collected
    const all: Close[] = [];
    let undatedClosed = 0;
    for (const r of rows.slice(1)) {
      const name = String(r?.[1] ?? "").trim();
      const status = String(r?.[2] ?? "").trim().toLowerCase();
      if (!name || status !== "closed") continue;
      const on = parseCloseDate(String(r?.[8] ?? ""));
      if (!on) { undatedClosed++; continue; } // no close date — no window to place it in
      all.push({
        name,
        closedOn: on.toISOString().slice(0, 10),
        upfront: money(r?.[9]),
        assignedTo: String(r?.[3] ?? "").trim(),
      });
    }

    // NEW cash only. A close belongs to a client who was already paying us
    // before that month is a renewal, not new cash — so it is dropped, using
    // the same first-appearance rule the New vs Recurring card uses.
    const firstSeen = await firstBillingMonth();
    const isNewCash = (c: Close) => {
      const first = firstSeen.get(nameKey(c.name));
      if (!first) return true;              // never billed before -> new
      return first >= c.closedOn.slice(0, 7); // first bill is this month or later
    };
    const newOnly = all.filter(isNewCash);

    const now = new Date();
    const since = (days: number) => {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - days);
      return d.toISOString().slice(0, 10);
    };
    const build = (key: Window["key"], label: string, keep: (c: Close) => boolean): Window => {
      const closes = newOnly.filter(keep).sort((a, b) => b.closedOn.localeCompare(a.closedOn));
      const upfrontTotal = closes.reduce((s, c) => s + c.upfront, 0);
      return { key, label, closes, closeCount: closes.length, upfrontTotal, expectedLtv: closes.length * avgLtv };
    };

    const d14 = since(14), d30 = since(30);
    const windows: Window[] = [
      build("d14", "Last 14 days", (c) => c.closedOn >= d14),
      build("d30", "Last 30 days", (c) => c.closedOn >= d30),
    ];

    if (ym) {
      // The MONTH window is driven by payments, not by the pipeline sheet.
      // 119 of 569 "Closed" rows carry no Close Date, and some clients (Martin
      // Aba) have no Demos row at all — they were invisible even though the
      // money arrived. The Financing workbook is where Square payments land, so
      // first-time payers there ARE the month's new cash. Demos is demoted to
      // enrichment: it supplies the closer and close date when a row matches.
      const byName = new Map<string, Close>();
      for (const c of all) {
        const k = nameKey(c.name);
        if (!byName.has(k)) byName.set(k, c);
      }
      const payers = await newPayersForMonth(ym);
      const monthCloses: Close[] = payers.map((p) => {
        const hit = byName.get(nameKey(p.name));
        return {
          name: p.name,
          closedOn: hit?.closedOn ?? "",
          upfront: p.amount || hit?.upfront || 0,
          assignedTo: hit?.assignedTo ?? "",
        };
      });
      const monthLabel = MONTHS.find((m) => m.ym === ym)?.label ?? ym;
      windows.unshift({
        key: "month",
        label: monthLabel,
        closes: monthCloses,
        closeCount: monthCloses.length,
        upfrontTotal: monthCloses.reduce((s, c) => s + c.upfront, 0),
        expectedLtv: monthCloses.length * avgLtv,
        fromPayments: true,
      });
    }

    return { windows, avgLtv, undatedClosed, generatedAt: new Date().toISOString() };
  } catch (err) {
    return { windows: [], avgLtv: 0, undatedClosed: 0, generatedAt: new Date().toISOString(), error: String(err) };
  }
}
