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
