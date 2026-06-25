import { google } from "googleapis";

// ─── Auth ────────────────────────────────────────────────────────────────────

export async function getSheetsClient() {
  let credentials: Record<string, unknown>;

  // Support full service-account JSON blob in one env var
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } catch {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
    }
  } else {
    const privateKey = (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
    credentials = {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: privateKey,
    };
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    // Full read + write access
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

// ─── Tab name discovery / resolution ─────────────────────────────────────────

const tabCache = new Map<string, string[]>();

export async function getTabNames(spreadsheetId: string): Promise<string[]> {
  if (tabCache.has(spreadsheetId)) return tabCache.get(spreadsheetId)!;
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties.title",
  });
  const names = res.data.sheets?.map((s) => s.properties?.title ?? "") ?? [];
  tabCache.set(spreadsheetId, names);
  return names;
}

export async function resolveTabName(
  spreadsheetId: string,
  preferredName: string,
  fallbackIndex = 0
): Promise<string> {
  const tabs = await getTabNames(spreadsheetId);
  if (tabs.includes(preferredName)) return preferredName;
  const lower = preferredName.toLowerCase();
  const ci = tabs.find((t) => t.toLowerCase() === lower);
  if (ci) return ci;
  const partial = tabs.find(
    (t) => t.toLowerCase().includes(lower) || lower.includes(t.toLowerCase())
  );
  if (partial) return partial;
  return tabs[fallbackIndex] ?? preferredName;
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function readSheetValues(
  spreadsheetId: string,
  sheetName: string,
  fallbackIndex = 0
): Promise<string[][]> {
  const sheets = await getSheetsClient();
  const resolvedName = await resolveTabName(spreadsheetId, sheetName, fallbackIndex);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${resolvedName}'`,
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  return (res.data.values ?? []) as string[][];
}

/**
 * Build column keys from a sheet's header row. Empty header cells become
 * `col_<n>`; duplicate header names get a numeric suffix so the FIRST occurrence
 * keeps the clean name (e.g. two "GMB" columns → "GMB" + "GMB_2"). Used by both
 * the reader and the writer so the round-trip stays consistent.
 */
export function buildHeaderNames(rawRow: unknown[]): string[] {
  const seen = new Map<string, number>();
  return rawRow.map((h, i) => {
    const base = String(h ?? "").trim() !== "" ? String(h).trim() : `col_${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}_${n}`;
  });
}

export function rowsToObjects(rows: string[][]): Record<string, unknown>[] {
  if (rows.length === 0) return [];

  // Find the best header row in the first 10 rows:
  // the first row whose non-empty cell count is >= 3 (skips merged title rows)
  let headerRowIdx = 0;
  let maxNonEmpty = 0;
  const scanLimit = Math.min(10, rows.length);
  for (let i = 0; i < scanLimit; i++) {
    const count = rows[i].filter((c) => c != null && String(c).trim() !== "").length;
    if (count > maxNonEmpty) {
      maxNonEmpty = count;
      headerRowIdx = i;
      if (count >= 3) break; // good enough header row found
    }
  }

  const headers = buildHeaderNames(rows[headerRowIdx]);

  // Store rows AFTER the header row (skip the header row itself).
  // row_number = actual 1-based sheet row index so write-back works correctly.
  return rows.slice(headerRowIdx + 1).map((row, rowIdx) => {
    const obj: Record<string, unknown> = { row_number: headerRowIdx + 2 + rowIdx };
    headers.forEach((h, i) => {
      const val = row[i];
      obj[h] = val === undefined || val === "" ? "" : val;
    });
    return obj;
  });
}

// ─── Write ────────────────────────────────────────────────────────────────────

/** Convert column number (1-based) to letter(s): 1→A, 26→Z, 27→AA */
function colLetter(n: number): string {
  let result = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

/**
 * Write a single row back to Google Sheets.
 * - rowNumber is 1-based (matches data.row_number from the sheet).
 * - data is the full row object; columns are mapped from the sheet's header row.
 */
export async function writeRowToSheet(
  spreadsheetId: string,
  sheetName: string,
  rowNumber: number,
  data: Record<string, unknown>,
  fallbackIndex = 0
): Promise<void> {
  const sheets = await getSheetsClient();
  const resolvedName = await resolveTabName(spreadsheetId, sheetName, fallbackIndex);

  // Find the header row — it is NOT always row 1 (some tabs, e.g. "Add Data -
  // Tracking", have title/note rows above the headers). Use the same detection
  // as rowsToObjects: the first row (within the top 10) with >=3 non-empty cells.
  const headerScan = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${resolvedName}'!1:10`,
    valueRenderOption: "FORMATTED_VALUE",
  });
  const scan = (headerScan.data.values ?? []) as string[][];
  if (scan.length === 0) throw new Error(`No data found in ${resolvedName}`);
  let headerRowIdx = 0;
  let maxNonEmpty = 0;
  const scanLimit = Math.min(10, scan.length);
  for (let i = 0; i < scanLimit; i++) {
    const count = (scan[i] ?? []).filter((c) => c != null && String(c).trim() !== "").length;
    if (count > maxNonEmpty) {
      maxNonEmpty = count;
      headerRowIdx = i;
      if (count >= 3) break;
    }
  }
  const headers = buildHeaderNames(scan[headerRowIdx] ?? []);
  if (headers.length === 0) throw new Error(`No headers found in ${resolvedName}`);

  // Build the values array in column order (keys match buildHeaderNames so two
  // columns sharing a title each get their own value back, not the same one).
  const values = headers.map((h) => {
    const v = data[h];
    return v === undefined || v === null ? "" : v;
  });

  const lastCol = colLetter(headers.length);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${resolvedName}'!A${rowNumber}:${lastCol}${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] },
  });
}

// ─── Sheet ↔ Table mapping ────────────────────────────────────────────────────

export const SHEET_MAP: Array<{
  spreadsheetId: string;
  sheetName: string;
  table: string;
  fallbackIndex: number;
  // Skipped by the scheduled cron (still syncable manually). The V3 tab has ~1000
  // rows of formulas Google recalculates on every read (~3 min for 40 rows), which
  // alone blows the serverless time limit and starves later tables.
  cronSkip?: boolean;
}> = [
  // Clients Master + V3 stay in the original master sheet (Clients Master is
  // written back to and referenced by the report tabs). The heavy data tabs were
  // split into a separate clean sheet (SHEET_DATA_ID) so they aren't dragged down.
  { spreadsheetId: process.env.SHEET1_ID!, sheetName: "Clients Master",           table: "clients_master",       fallbackIndex: 0 },
  { spreadsheetId: process.env.SHEET1_ID!, sheetName: "V3",                       table: "v3_pricing",           fallbackIndex: 2, cronSkip: true },
  { spreadsheetId: process.env.SHEET_DATA_ID!, sheetName: "Leads Master",         table: "leads_master",         fallbackIndex: 0 },
  { spreadsheetId: process.env.SHEET_DATA_ID!, sheetName: "Deposits",             table: "deposits",             fallbackIndex: 0 },
  { spreadsheetId: process.env.SHEET_DATA_ID!, sheetName: "Outgoing Call Master", table: "outgoing_calls",       fallbackIndex: 0 },
  { spreadsheetId: process.env.SHEET_DATA_ID!, sheetName: "Bookings Master",      table: "bookings",             fallbackIndex: 0 },
  { spreadsheetId: process.env.SHEET_DATA_ID!, sheetName: "Signed Agreements",    table: "signed_agreements",    fallbackIndex: 0 },
  { spreadsheetId: process.env.SHEET2_ID!, sheetName: "Sheet1",                   table: "ltv_sheet1",           fallbackIndex: 0 },
  { spreadsheetId: process.env.SHEET2_ID!, sheetName: "Sheet2",                   table: "ltv_sheet2",           fallbackIndex: 1 },
  { spreadsheetId: process.env.SHEET3_ID!, sheetName: "Add Data - Tracking",      table: "performance_tracking", fallbackIndex: 0 },
  { spreadsheetId: process.env.SHEET4_ID!, sheetName: "7 Days CPL",               table: "cpl_7days",            fallbackIndex: 0 },
  { spreadsheetId: process.env.SHEET4_ID!, sheetName: "14 Days CPL",              table: "cpl_14days",           fallbackIndex: 1 },
  { spreadsheetId: process.env.SHEET4_ID!, sheetName: "30 Days CPL",              table: "cpl_30days",           fallbackIndex: 2 },
  { spreadsheetId: process.env.SHEET4_ID!, sheetName: "All Time Campaign Budget", table: "campaign_spent",       fallbackIndex: 3 },
];

export function getSheetEntryForTable(table: string) {
  return SHEET_MAP.find((s) => s.table === table);
}
