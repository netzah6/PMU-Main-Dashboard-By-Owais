import { createServiceClient } from "@/lib/supabase/server";
import { getSheetsClient, getTabNames } from "@/lib/sheets";
import { normalizeOwnerKey } from "@/lib/normalizers";

// Map a month-tab title (e.g. "June V2", "March") to a calendar month number so
// we can always pick the most recent month automatically as new tabs are added.
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function monthOf(tabTitle: string): number | null {
  const first = tabTitle.trim().toLowerCase().split(/\s+/)[0];
  return MONTHS[first] ?? null;
}

/** Choose the latest month tab present in the financing spreadsheet. */
export function pickLatestMonthTab(tabs: string[]): string | null {
  let best: { title: string; month: number } | null = null;
  for (const t of tabs) {
    const m = monthOf(t);
    if (m == null) continue;
    // Prefer the highest month; on ties prefer a "V2"/later-listed variant.
    if (!best || m >= best.month) best = { title: t, month: m };
  }
  return best?.title ?? null;
}

interface PaymentRow {
  owner_key: string;
  client_name: string;
  usd: number | null;
  payment_status: string;
  billing_status: string;
  pay_day: string;
  notes: string;
  month: string;
}

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

/** Locate header row + column indices by matching header text (robust to layout shifts). */
function mapColumns(rows: string[][]) {
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const row = rows[i].map(norm);
    const nameIdx = row.findIndex((c) => c === "client name");
    if (nameIdx === -1) continue;
    const find = (...labels: string[]) =>
      row.findIndex((c) => labels.some((l) => c === l || c.includes(l)));
    return {
      headerRow: i,
      name: nameIdx,
      usd: find("usd"),
      payStatus: find("payment status"),
      billStatus: find("billing status"),
      payDay: find("day of payment", "day of renew"),
      notes: find("notes about their monthly plan", "notes"),
    };
  }
  return null;
}

function parseUsd(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = parseFloat(String(v).replace(/[$,]/g, ""));
  return isNaN(n) ? null : n;
}

/** Skip non-client aggregate rows. */
function isSkipRow(name: string): boolean {
  const n = name.toLowerCase();
  return (
    !name ||
    n.includes("total") ||
    n.includes("deposits from clients") ||
    n === "client name"
  );
}

export interface PaymentSyncResult {
  status: "ok" | "error";
  month?: string;
  rows?: number;
  error?: string;
}

/**
 * Read the latest month tab of the financing sheet and upsert one row per
 * client into client_payments, keyed by normalized owner name.
 */
export async function syncPayments(): Promise<PaymentSyncResult> {
  const spreadsheetId = process.env.SHEET5_ID;
  if (!spreadsheetId) return { status: "error", error: "SHEET5_ID not set" };

  try {
    const tabs = await getTabNames(spreadsheetId);
    const monthTab = pickLatestMonthTab(tabs);
    if (!monthTab) return { status: "error", error: "No month tab found" };

    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${monthTab}'!A1:H200`,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const rows = (res.data.values ?? []) as string[][];
    const cols = mapColumns(rows);
    if (!cols) return { status: "error", error: `No header row in "${monthTab}"` };

    const seen = new Set<string>();
    const payments: PaymentRow[] = [];
    for (let i = cols.headerRow + 1; i < rows.length; i++) {
      const row = rows[i] ?? [];
      const clientName = String(row[cols.name] ?? "").trim();
      if (isSkipRow(clientName)) continue;
      const key = normalizeOwnerKey(clientName);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      payments.push({
        owner_key: key,
        client_name: clientName,
        usd: cols.usd >= 0 ? parseUsd(row[cols.usd]) : null,
        payment_status: cols.payStatus >= 0 ? String(row[cols.payStatus] ?? "").trim() : "",
        billing_status: cols.billStatus >= 0 ? String(row[cols.billStatus] ?? "").trim() : "",
        pay_day: cols.payDay >= 0 ? String(row[cols.payDay] ?? "").trim() : "",
        notes: cols.notes >= 0 ? String(row[cols.notes] ?? "").trim() : "",
        month: monthTab,
      });
    }

    const supabase = createServiceClient();
    const now = new Date().toISOString();
    // Replace the table contents with the latest month's snapshot.
    await supabase.from("client_payments").delete().neq("owner_key", "");
    if (payments.length) {
      const { error } = await supabase
        .from("client_payments")
        .upsert(payments.map((p) => ({ ...p, updated_at: now })), { onConflict: "owner_key" });
      if (error) throw new Error(error.message);
    }

    return { status: "ok", month: monthTab, rows: payments.length };
  } catch (err) {
    return { status: "error", error: String(err) };
  }
}
