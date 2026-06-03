import { NextResponse } from "next/server";
import { getSheetsClient } from "@/lib/sheets";
import { createClient } from "@/lib/supabase/server";

const SPREADSHEET_IDS = {
  SHEET1: process.env.SHEET1_ID!,
  SHEET2: process.env.SHEET2_ID!,
  SHEET3: process.env.SHEET3_ID!,
  SHEET4: process.env.SHEET4_ID!,
};

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const sheets = await getSheetsClient();
    const result: Record<string, string[]> = {};

    for (const [key, id] of Object.entries(SPREADSHEET_IDS)) {
      const res = await sheets.spreadsheets.get({
        spreadsheetId: id,
        fields: "sheets.properties.title",
      });
      result[key] = res.data.sheets?.map((s) => s.properties?.title ?? "") ?? [];
    }

    return NextResponse.json({ spreadsheets: result });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
