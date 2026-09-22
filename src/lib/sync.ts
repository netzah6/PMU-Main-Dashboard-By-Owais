import { createServiceClient } from "@/lib/supabase/server";
import { readSheetValues, rowsToObjects, SHEET_MAP } from "@/lib/sheets";
import { identityKeys, identityKeysLoose, rowDate, resolveTable } from "@/lib/direct-ingest";

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
  /* Page through ALL direct rows. PostgREST caps an un-ranged select at
     1,000 rows and this query had no order, so once bookings passed 1,000
     webhook rows the newest ones were never even looked at — every new
     booking showed twice (Beauty by May, 2026-09-21; 1,037 stale twins). */
  const direct: { id: string; data: unknown; synced_at: string | null }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data: page } = await supabase
      .from(table)
      .select("id, data, synced_at")
      .not("external_id", "is", null)
      .is("sheet_row", null)
      .order("id")
      .range(from, from + 999);
    direct.push(...(page ?? []));
    if (!page || page.length < 1000) break;
  }
  if (direct.length === 0) return 0;

  // Every identifier the sheet knows about. Matching per identifier (rather
  // than one all-fields fingerprint) is what lets a webhook row carrying a
  // phone retire against a sheet row that has none.
  const inSheet = new Set(sheetObjects.flatMap((o) => identityKeys(t, o)));
  // Date-tolerant second pass: the sheet stamps UTC dates, the webhook stamps
  // the payment moment, so the same deposit can carry two adjacent calendar
  // days (paid in the evening Pacific = next day UTC). Match everything-but-
  // the-date and allow the dates to differ by up to 3 days.
  const DAY = 86_400_000;
  const looseDates = new Map<string, number[]>();
  for (const o of sheetObjects) {
    const d = rowDate(o);
    if (Number.isNaN(d)) continue;
    for (const k of identityKeysLoose(t, o)) {
      if (!looseDates.has(k)) looseDates.set(k, []);
      looseDates.get(k)!.push(d);
    }
  }
  const superseded = direct
    .filter((r) => {
      const row = (r.data ?? {}) as Record<string, unknown>;
      if (identityKeys(t, row).some((k) => inSheet.has(k))) return true;
      const near = identityKeysLoose(t, row).flatMap((k) => looseDates.get(k) ?? []);
      if (!near.length) return false;
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
  /** Stale DB rows removed because their sheet row is now VOID/blank. */
  voidedDeleted?: number;
  /** Rows written this run (the rest were identical to what's stored). */
  rowsWritten?: number;
  rowsUnchanged?: number;
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

/* Stable JSON for change detection: jsonb comes back with keys in its own
   order, sheet objects in column order — sort keys so equal data compares
   equal. */
function canonical(o: Record<string, unknown>): string {
  return JSON.stringify(o, Object.keys(o).sort());
}

/* Current rows keyed by sheet_row (canonical data), paged past PostgREST's
   1,000-row cap. Returns null if the read fails, in which case the caller
   falls back to upserting everything — a full rewrite is safe, just noisy. */
async function loadExistingByRow(
  supabase: ReturnType<typeof createServiceClient>,
  table: string
): Promise<Map<number, string> | null> {
  const out = new Map<number, string>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select("sheet_row, data")
      .not("sheet_row", "is", null)
      .order("sheet_row")
      .range(from, from + PAGE - 1);
    if (error) return null;
    for (const r of (data ?? []) as Array<{ sheet_row: number; data: Record<string, unknown> }>) {
      out.set(Number(r.sheet_row), canonical(r.data ?? {}));
    }
    if (!data || data.length < PAGE) break;
  }
  return out;
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
    // Drop rows with no content: fully-blank rows and rows marked VOID in
    // column A. Blank rows are how deleted duplicates were neutralized after
    // the 2026-08-20 lesson — a fully-empty row makes Google's table detection
    // end the table there, so appends INSERT mid-sheet; the fix is a VOID
    // marker in column A, and the sync must not ingest those markers as data.
    // This must NOT require any specific column: an earlier version kept only
    // rows with an Email/Name-style value, which silently emptied every table
    // whose sheet has no such column (the CPL tabs, campaign_spent, ltv_sheet2,
    // v3_pricing) — their syncs returned "ok, 0 rows" from Aug 20 onward.
    const voidedRows: number[] = [];
    const objects = rowsToObjects(rawRows).filter((o) => {
      const values = Object.entries(o)
        .filter(([k]) => k !== "row_number")
        .map(([, v]) => String(v ?? "").trim());
      const dead = !values.some((v) => v !== "") // fully blank
        || (values[0] ?? "").toUpperCase() === "VOID"; // dedupe marker
      if (dead) {
        const rn = Number(o.row_number) || 0;
        if (rn > 0) voidedRows.push(rn);
        return false;
      }
      return true;
    });

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

    // 2. UPSERT by sheet_row in batches of 500 — but only rows whose data
    //    actually changed. Rewriting every row every minute (deposits: ~1,000
    //    rows × 1,440 runs/day) fired ~1.4M Realtime change events per day
    //    per open Deposits/Clients tab and blew the org past its 5M/month
    //    Realtime quota (16.9M by 2026-09-18), on top of the standing write
    //    load behind the Aug-15 overload. Unchanged rows keep their synced_at
    //    (= the moment the row first arrived, which is what
    //    dropSupersededDirectRows wants anyway).
    const BATCH = 500;
    const now = new Date().toISOString();
    let maxSheetRow = 0;
    const existing = await loadExistingByRow(supabase, table);
    let unchanged = 0;

    // Wrong-tab guard: readSheetValues falls back to a tab INDEX when the
    // named tab is missing, so a wrong spreadsheet id (or a renamed tab)
    // would happily pour another sheet's rows into this table. If the
    // columns coming in barely overlap the columns already stored, this is
    // not the same data — refuse rather than corrupt (2026-09-18 incident:
    // the Deposits tab landed in clients_master for a few minutes).
    if (existing && existing.size >= 20 && objects.length) {
      const stored = new Set<string>();
      for (const [, canon] of existing) { for (const k of Object.keys(JSON.parse(canon) as Record<string, unknown>)) stored.add(k); if (stored.size > 200) break; }
      const incoming = Object.keys(objects[0]);
      const overlap = incoming.filter((k) => stored.has(k)).length / Math.max(1, incoming.length);
      if (overlap < 0.5) {
        throw new Error(`refused: incoming columns match only ${Math.round(overlap * 100)}% of the stored columns — wrong sheet/tab for table "${table}"?`);
      }
    }

    const changed = objects.filter((data) => {
      const sr = Number(data.row_number) || 0;
      if (sr > maxSheetRow) maxSheetRow = sr;
      const prev = existing?.get(sr);
      if (prev !== undefined && prev === canonical(data)) { unchanged++; return false; }
      return true;
    });

    for (let i = 0; i < changed.length; i += BATCH) {
      const batch = changed.slice(i, i + BATCH).map((data) => ({ sheet_row: Number(data.row_number) || 0, data, synced_at: now }));
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

    /* 3b. A VOID/blank sheet row means "this row is dead" — but because dead
       rows are skipped by the upsert, whatever the DB stored at that
       sheet_row BEFORE it was voided stays behind forever (that's how a
       VOID-deduped client kept double-counting a coach's live total,
       2026-09-22). Delete those positions explicitly. sheet_row-keyed rows
       are sheet-owned by definition, so direct-ingest rows (sheet_row null)
       can't be touched here. */
    let voidedDeleted = 0;
    for (let i = 0; i < voidedRows.length; i += 100) {
      const { count } = await supabase
        .from(table)
        .delete({ count: "exact" })
        .in("sheet_row", voidedRows.slice(i, i + 100));
      voidedDeleted += count ?? 0;
    }

    // 4. Retire direct-ingest rows the sheet has now caught up on, so a record
    //    that arrived by webhook first isn't shown twice.
    const supersededDirect = await dropSupersededDirectRows(table, objects);

    const { count: afterCount } = await supabase
      .from(table)
      .select("*", { count: "estimated", head: true });

    // A run that wrote nothing still ran: the freshness badge reads this
    // (data_freshness view → sheet_sync_runs), not max(synced_at), now that
    // unchanged rows keep their old synced_at.
    await supabase.from("sheet_sync_runs").upsert({
      table_name: table, ran_at: now, sheet_rows: objects.length,
      rows_written: changed.length, rows_unchanged: unchanged, status: "ok", error: null,
    }, { onConflict: "table_name" }).then(() => undefined, () => undefined);

    return {
      table, sheetName,
      sheetRows: objects.length,
      supabaseRowsBefore: beforeCount ?? 0,
      supabaseRowsAfter: afterCount ?? 0,
      supersededDirect,
      deleteSkipped,
      voidedDeleted,
      rowsWritten: changed.length,
      rowsUnchanged: unchanged,
      status: "ok",
      durationMs: Date.now() - start,
    };
  } catch (err) {
    await supabase.from("sheet_sync_runs").upsert({
      table_name: table, ran_at: new Date().toISOString(), status: "error", error: String(err).slice(0, 500),
    }, { onConflict: "table_name" }).then(() => undefined, () => undefined);
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
