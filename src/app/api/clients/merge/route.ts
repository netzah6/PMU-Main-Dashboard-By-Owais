import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { writeRowToSheet, getSheetEntryForTable } from "@/lib/sheets";

export const maxDuration = 60;

// Merge two duplicate rows of the Clients Master sheet into one.
//
// The keeper row gets the field values the admin picked; the other row is
// marked VOID in column A. VOID rather than cleared on purpose: a fully blank
// row makes Google's table detection stop there, so later appends land in the
// middle of the sheet (the 2026-08-20 lesson). The sync already skips rows
// whose first column reads VOID.
//
// Admin only, and deliberately not reversible from the UI — the sheet keeps
// the voided row, so a mistake can be undone by hand in Google Sheets.

// Column A of Clients Master has a blank header, so the sync stores it as
// `col_1`. It doubles as the client status (Live / Paused / …).
const STATUS_COL = "col_1";

export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") {
    return NextResponse.json({ error: "Only an admin can merge clients" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    keepRow?: number;
    dropRow?: number;
    values?: Record<string, unknown>;
  };
  const keepRow = Number(body.keepRow);
  const dropRow = Number(body.dropRow);
  const values = body.values ?? {};
  if (!keepRow || !dropRow || keepRow === dropRow) {
    return NextResponse.json({ error: "keepRow and dropRow must be two different rows" }, { status: 400 });
  }

  const svc = createServiceClient();
  const { data: rows, error: readErr } = await svc
    .from("clients_master")
    .select("sheet_row, data")
    .in("sheet_row", [keepRow, dropRow]);
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  const keep = (rows ?? []).find((r) => Number(r.sheet_row) === keepRow);
  const drop = (rows ?? []).find((r) => Number(r.sheet_row) === dropRow);
  if (!keep || !drop) {
    return NextResponse.json({ error: "One of those rows no longer exists — refresh and try again" }, { status: 404 });
  }

  const entry = getSheetEntryForTable("clients_master");
  if (!entry) return NextResponse.json({ error: "Clients Master sheet not configured" }, { status: 500 });

  const keepData = (keep.data ?? {}) as Record<string, unknown>;
  const dropData = (drop.data ?? {}) as Record<string, unknown>;

  // Only the fields that actually change are written, so a merge can never
  // clobber a column the admin did not look at.
  const changed = Object.keys(values).filter(
    (k) => k !== "row_number" && String(values[k] ?? "") !== String(keepData[k] ?? "")
  );

  try {
    if (changed.length) {
      const merged = { ...keepData, ...values, row_number: keepRow };
      await writeRowToSheet(entry.spreadsheetId, entry.sheetName, keepRow, merged, entry.fallbackIndex, changed);
      await svc.from("clients_master").update({ data: merged }).eq("sheet_row", keepRow);
    }

    // Void the loser. Written before the local delete so a failure here leaves
    // both rows visible rather than losing one from the dashboard only.
    await writeRowToSheet(
      entry.spreadsheetId,
      entry.sheetName,
      dropRow,
      { ...dropData, [STATUS_COL]: "VOID", row_number: dropRow },
      entry.fallbackIndex,
      [STATUS_COL]
    );
    await svc.from("clients_master").delete().eq("sheet_row", dropRow);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Merge failed while writing to the sheet" },
      { status: 502 }
    );
  }

  return NextResponse.json({
    success: true,
    keptRow: keepRow,
    voidedRow: dropRow,
    fieldsWritten: changed,
  });
}
