import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

// Maps Google Sheet tab names → Supabase tables.
// Includes common aliases so the Apps Script doesn't need exact names.
const SHEET_TO_TABLE: Record<string, string> = {
  "Clients Master": "clients_master",
  "Leads Master": "leads_master",
  "Deposits": "deposits",
  "Outgoing Call Master": "outgoing_calls",
  "Bookings Master": "bookings",
  "Signed Agreements": "signed_agreements",
  "Sheet1": "ltv_sheet1",
  "Sheet2": "ltv_sheet2",
  "LTV Sheet1": "ltv_sheet1",
  "LTV Sheet2": "ltv_sheet2",
  "Add Data - Tracking": "performance_tracking",
  "7 Days CPL": "cpl_7days",
  "14 Days CPL": "cpl_14days",
  "All Time Campaign Budget": "campaign_spent",
};

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { sheetName, rowNumber, rowData } = body as {
    sheetName: string;
    rowNumber: number;
    rowData: Record<string, unknown>;
  };

  const tableName = SHEET_TO_TABLE[sheetName];
  if (!tableName) {
    return NextResponse.json({ error: `Unknown sheet: ${sheetName}` }, { status: 400 });
  }
  if (!rowNumber || !rowData) {
    return NextResponse.json({ error: "rowNumber and rowData required" }, { status: 400 });
  }

  const supabase = createServiceClient();

  // Ensure row_number is inside the data blob too (keeps normalizers happy)
  const data = { ...rowData, row_number: rowNumber };

  // Upsert by stable sheet_row key — preserves UUID, triggers one realtime event
  const { error } = await supabase
    .from(tableName)
    .upsert(
      { sheet_row: rowNumber, data, synced_at: new Date().toISOString() },
      { onConflict: "sheet_row" }
    );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
