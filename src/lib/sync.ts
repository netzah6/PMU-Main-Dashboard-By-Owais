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
 * Strategy: DELETE all existing rows, then INSERT fresh from sheet.
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

  // Count existing rows
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

    // 2. Delete all existing rows
    await supabase.from(table).delete().not("id", "is", null);

    // 3. Insert fresh data in batches of 200
    const BATCH = 200;
    const now = new Date().toISOString();
    for (let i = 0; i < objects.length; i += BATCH) {
      const batch = objects.slice(i, i + BATCH).map((data) => ({
        data,
        synced_at: now,
      }));
      const { error } = await supabase.from(table).insert(batch);
      if (error) throw new Error(`Batch ${i / BATCH + 1}: ${error.message}`);
    }

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
