import { createServiceClient } from "@/lib/supabase/server";
import { readSheetValues, rowsToObjects, SHEET_MAP } from "@/lib/sheets";

export interface SyncResult {
  table: string;
  sheetName: string;
  sheetRows: number;
  supabaseRowsBefore: number;
  supabaseRowsAfter: number;
  status: "ok" | "error";
  error?: string;
  durationMs: number;
}

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

  const { count: beforeCount } = await supabase
    .from(table)
    .select("*", { count: "exact", head: true });

  try {
    // 1. Read from Google Sheets (auto-resolves tab name if needed)
    const rawRows = await readSheetValues(spreadsheetId, sheetName, fallbackIndex);
    const objects = rowsToObjects(rawRows);

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

    // 3. Delete rows that were removed from the sheet (sheet_row beyond current max)
    await supabase.from(table).delete().gt("sheet_row", maxSheetRow);

    const { count: afterCount } = await supabase
      .from(table)
      .select("*", { count: "exact", head: true });

    return {
      table, sheetName,
      sheetRows: objects.length,
      supabaseRowsBefore: beforeCount ?? 0,
      supabaseRowsAfter: afterCount ?? 0,
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
  for (const { spreadsheetId, sheetName, table, fallbackIndex } of SHEET_MAP) {
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
