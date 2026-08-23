import { createServiceClient } from "@/lib/supabase/server";
import { readSheetValues, rowsToObjects, SHEET_MAP } from "@/lib/sheets";
import { fingerprint, fingerprintLoose, rowDate, resolveTable } from "@/lib/direct-ingest";

/**
 * Drop direct-ingest rows that the sheet has now caught up on.
 *
 * Rows posted to /api/webhooks land with `external_id` set and `sheet_row` NULL,
 * so the "delete rows past the sheet's last row" step below can't touch them
 * (NULL > n is never true — deliberately, so a direct row survives until the
 * sheet is read). But once the sheet read finally succeeds, the same record
 * arrives again with a real sheet_row, and without this the dashboard would
 * show it twice.
 *
 * The sheet is the system of record, so the sheet copy wins and the early
 * direct copy is removed. A direct row with no counterpart in the sheet — a
 * manual backfill, or a record the sheet genuinely never received — is kept.
 */
async function dropSupersededDirectRows(
  table: string,
  sheetObjects: Record<string, unknown>[]
): Promise<number> {
  const t = resolveTable(table);
  if (!t) return 0;

  const supabase = createServiceClient();
  const { data: direct } = await supabase
    .from(table)
    .select("id, data, synced_at")
    .not("external_id", "is", null)
    .is("sheet_row", null);
  if (!direct || direct.length === 0) return 0;

  const inSheet = new Set(sheetObjects.map((o) => fingerprint(t, o)));
  // Date-tolerant second pass: the sheet stamps UTC dates, the webhook stamps
  // the payment moment, so the same deposit can carry two adjacent calendar
  // days (paid in the evening Pacific = next day UTC). Match everything-but-
  // the-date and allow the dates to differ by up to 3 days.
  const DAY = 86_400_000;
  const looseDates = new Map<string, number[]>();
  for (const o of sheetObjects) {
    const k = fingerprintLoose(t, o);
    if (!looseDates.has(k)) looseDates.set(k, []);
    const d = rowDate(o);
    if (!Number.isNaN(d)) looseDates.get(k)!.push(d);
  }
  const superseded = direct
    .filter((r) => {
      const row = (r.data ?? {}) as Record<string, unknown>;
      if (inSheet.has(fingerprint(t, row))) return true;
      const near = looseDates.get(fingerprintLoose(t, row));
      if (!near) return false;
      // Two candidate dates for a direct row: the payload's Date field, and
      // the row's ARRIVAL time. Make's webhook sometimes fills Date with the
      // lead's signup date, months before the payment (17 Commas-verified
      // cases on 2026-08-23) — but the webhook always FIRES seconds after the
      // charge, so synced_at is the trustworthy payment moment.
      const cands = [rowDate(row), r.synced_at ? Date.parse(String(r.synced_at)) : NaN]
        .filter((d) => !Number.isNaN(d));
      return cands.some((d) => near.some((sd) => Math.abs(sd - d) <= 3 * DAY));
    })
    .map((r) => r.id);
  if (superseded.length === 0) return 0;

  await supabase.from(table).delete().in("id", superseded);
  return superseded.length;
}

export interface SyncResult {
  table: string;
  sheetName: string;
  sheetRows: number;
  supabaseRowsBefore: number;
  supabaseRowsAfter: number;
  /** Direct-ingest rows retired because the sheet caught up on them. */
  supersededDirect?: number;
  /** Set when the tail-delete guard refused to run — says why. */
  deleteSkipped?: string;
  status: "ok" | "error";
  error?: string;
  durationMs: number;
}

// Circuit breaker for the tail delete. A sheet legitimately shrinks by a
// handful of rows (someone deletes a bad entry); it never legitimately loses
// dozens at once. When more rows than this sit past the sheet's end, the far
// more likely explanation is that THIS READ was partial or truncated — and
// deleting on a partial read is exactly how the 2026-08-15 meltdown fed
// itself (the same DELETE repeated 1,880× in 2h while Make kept re-posting
// the rows it wiped). Refuse, report, let the next clean read handle it.
const MAX_TAIL_DELETE = 25;

export interface ValidationResult {
  table: string;
  sheetRows: number;
  supabaseRows: number;
  inSync: boolean;
  missingInSupabase: number;
  extraInSupabase: number;
}

/**
 * Sync a single sheet tab → Supabase table.
 * Strategy: UPSERT by sheet_row (stable key), then delete rows that no longer
 * exist in the sheet. Non-destructive — UUIDs stay stable so Supabase Realtime
 * only fires for rows that actually changed.
 * Uses service role key to bypass RLS.
 */
export async function syncOneSheet(
  spreadsheetId: string,
  sheetName: string,
  table: string,
  fallbackIndex = 0
): Promise<SyncResult> {
  const start = Date.now();
  const supabase = createServiceClient();

  // Estimated, not exact: these counts are report-only, and an exact count
  // scans the whole table — two full scans per table per sync run was a real
  // share of the standing DB load. (The tail-delete count below stays exact:
  // it's filtered on the sheet_row unique index, so it's cheap — and the
  // guard needs the true number.)
  const { count: beforeCount } = await supabase
    .from(table)
    .select("*", { count: "estimated", head: true });

  try {
    // 1. Read from Google Sheets (auto-resolves tab name if needed)
    const rawRows = await readSheetValues(spreadsheetId, sheetName, fallbackIndex);
    // Drop rows with no identifying content: fully-blank rows and rows marked
    // VOID. Blank rows are how deleted duplicates were neutralized after the
    // 2026-08-20 lesson — a fully-empty row makes Google's table detection end
    // the table there, so appends INSERT mid-sheet; the fix is a VOID marker in
    // column A, and the sync must not ingest those markers as data.
    const objects = rowsToObjects(rawRows).filter((o) =>
      [o["Email"], o["Full Name"], o["Business Name"], o["Name"]].some(
        (v) => String(v ?? "").trim() !== ""
      )
    );

    if (objects.length === 0) {
      return {
        table, sheetName,
        sheetRows: 0,
        supabaseRowsBefore: beforeCount ?? 0,
        supabaseRowsAfter: beforeCount ?? 0,
        status: "ok",
        durationMs: Date.now() - start,
      };
    }

    // 2. UPSERT by sheet_row in batches of 500
    const BATCH = 500;
    const now = new Date().toISOString();
    let maxSheetRow = 0;

    for (let i = 0; i < objects.length; i += BATCH) {
      const batch = objects.slice(i, i + BATCH).map((data) => {
        const sr = Number(data.row_number) || 0;
        if (sr > maxSheetRow) maxSheetRow = sr;
        return { sheet_row: sr, data, synced_at: now };
      });
      const { error } = await supabase
        .from(table)
        .upsert(batch, { onConflict: "sheet_row" });
      if (error) throw new Error(`Batch ${i / BATCH + 1}: ${error.message}`);
    }

    // 3. Delete rows that were removed from the sheet (sheet_row beyond current max).
    //
    // Two guards, both born on 2026-08-15:
    //  a) Direct-ingest rows are UNTOUCHABLE here. Make posts fresh payments
    //     with real row numbers past the sheet's current end (the sheet hasn't
    //     caught up yet), so "past the end" does NOT mean "removed from the
    //     sheet" for rows carrying an external_id. Deleting them starts a
    //     delete/re-add ping-pong with Make's retries. They're retired by
    //     dropSupersededDirectRows below, once the sheet truly has them.
    //  b) Mass deletes are refused (MAX_TAIL_DELETE) — see the constant.
    let deleteSkipped: string | undefined;
    const directTable = !!resolveTable(table);
    const tailQuery = () => {
      let q = supabase.from(table).delete().gt("sheet_row", maxSheetRow);
      if (directTable) q = q.is("external_id", null);
      return q;
    };
    let staleQ = supabase
      .from(table)
      .select("*", { count: "exact", head: true })
      .gt("sheet_row", maxSheetRow);
    if (directTable) staleQ = staleQ.is("external_id", null);
    const { count: staleCount } = await staleQ;
    if ((staleCount ?? 0) > MAX_TAIL_DELETE) {
      deleteSkipped = `refused to delete ${staleCount} rows past sheet end (limit ${MAX_TAIL_DELETE}) — this read was likely partial, not a real sheet shrink`;
    } else if ((staleCount ?? 0) > 0) {
      await tailQuery();
    }

    // 4. Retire direct-ingest rows the sheet has now caught up on, so a record
    //    that arrived by webhook first isn't shown twice.
    const supersededDirect = await dropSupersededDirectRows(table, objects);

    const { count: afterCount } = await supabase
      .from(table)
      .select("*", { count: "estimated", head: true });

    return {
      table, sheetName,
      sheetRows: objects.length,
      supabaseRowsBefore: beforeCount ?? 0,
      supabaseRowsAfter: afterCount ?? 0,
      supersededDirect,
      deleteSkipped,
      status: "ok",
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      table, sheetName,
      sheetRows: 0,
      supabaseRowsBefore: beforeCount ?? 0,
      supabaseRowsAfter: beforeCount ?? 0,
      status: "error",
      error: String(err),
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Sync ALL sheets to Supabase sequentially.
 */
export async function syncAllSheets(): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (const { spreadsheetId, sheetName, table, fallbackIndex, cronSkip } of SHEET_MAP) {
    if (cronSkip) continue; // pathologically slow sheets — sync these manually
    const result = await syncOneSheet(spreadsheetId, sheetName, table, fallbackIndex);
    results.push(result);
  }
  return results;
}

/**
 * Validate each sheet against Supabase without writing.
 * Compares row counts from Google Sheets vs Supabase.
 */
export async function validateAllSheets(): Promise<ValidationResult[]> {
  const supabase = createServiceClient();
  const results: ValidationResult[] = [];

  for (const { spreadsheetId, sheetName, table, fallbackIndex } of SHEET_MAP) {
    try {
      const rawRows = await readSheetValues(spreadsheetId, sheetName, fallbackIndex);
      const sheetRows = rawRows.length; // includes header row

      const { count: supabaseRows } = await supabase
        .from(table)
        .select("*", { count: "exact", head: true });

      const sb = supabaseRows ?? 0;
      results.push({
        table,
        sheetRows,
        supabaseRows: sb,
        inSync: sheetRows === sb,
        missingInSupabase: Math.max(0, sheetRows - sb),
        extraInSupabase: Math.max(0, sb - sheetRows),
      });
    } catch {
      results.push({
        table,
        sheetRows: -1,
        supabaseRows: -1,
        inSync: false,
        missingInSupabase: 0,
        extraInSupabase: 0,
      });
    }
  }

  return results;
}
