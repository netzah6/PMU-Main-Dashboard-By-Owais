import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { writeRowToSheet, getSheetEntryForTable } from "@/lib/sheets";

export async function GET(
  _req: NextRequest,
  { params }: { params: { table: string } }
) {
  const supabase = createClient();
  const { data, error } = await supabase
    .from(params.table)
    .select("id, data")
    .order("id", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type DbRow = { id: string; data: Record<string, unknown> };
  return NextResponse.json({
    data: (data ?? []).map((r: DbRow) => ({
      ...r.data,
      _supabase_id: r.id,
      _row_number: r.data?.row_number,
    })),
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { table: string } }
) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { rowNumber, rowData } = body as {
    rowNumber: number;
    rowData: Record<string, unknown>;
  };

  if (!rowNumber || !rowData) {
    return NextResponse.json({ error: "rowNumber and rowData required" }, { status: 400 });
  }

  const serviceClient = createServiceClient();

  // Strip internal meta fields, but keep row_number inside the data blob
  const { _supabase_id: _s, _row_number: _r, ...rest } = rowData;
  void _s; void _r;
  const cleanData = { ...rest, row_number: rowNumber };

  // 1. Update Supabase by stable sheet_row key
  const { error: updateErr } = await serviceClient
    .from(params.table)
    .update({ data: cleanData, synced_at: new Date().toISOString() })
    .eq("sheet_row", rowNumber);

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  // 2. Write back to Google Sheets
  const sheetEntry = getSheetEntryForTable(params.table);
  let sheetsUpdated = false;
  let sheetsError: string | null = null;

  if (sheetEntry) {
    try {
      await writeRowToSheet(
        sheetEntry.spreadsheetId,
        sheetEntry.sheetName,
        rowNumber,
        cleanData,
        sheetEntry.fallbackIndex
      );
      sheetsUpdated = true;
    } catch (e) {
      sheetsError = String(e);
      console.error(`[PATCH] Sheets write-back failed for ${params.table} row ${rowNumber}:`, e);
    }
  }

  return NextResponse.json({ success: true, sheetsUpdated, sheetsError });
}
