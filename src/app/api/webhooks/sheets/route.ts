import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

const SHEET_TO_TABLE: Record<string, string> = {
  "Clients Master": "clients_master",
  "Leads Master": "leads_master",
  "Deposits": "deposits",
  "Outgoing Call Master": "outgoing_calls",
  "Bookings Master": "bookings",
  "Signed Agreements": "signed_agreements",
  "LTV Sheet1": "ltv_sheet1",
  "LTV Sheet2": "ltv_sheet2",
  "Add Data - Tracking": "performance_tracking",
  "7 Days CPL": "cpl_7days",
  "14 Days CPL": "cpl_14days",
  "All Time Campaign Budget": "campaign_spent",
};

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { sheetName, rowNumber, rowData } = body;

  const tableName = SHEET_TO_TABLE[sheetName];
  if (!tableName) {
    return NextResponse.json({ error: `Unknown sheet: ${sheetName}` }, { status: 400 });
  }

  const supabase = createServiceClient();

  const { error } = await supabase
    .from(tableName)
    .upsert({ id: rowNumber, data: rowData }, { onConflict: "id" });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
