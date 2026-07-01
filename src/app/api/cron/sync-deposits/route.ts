import { NextRequest, NextResponse } from "next/server";
import { SHEET_MAP } from "@/lib/sheets";
import { syncOneSheet } from "@/lib/sync";

export const maxDuration = 60;

// Fast, deposits-only sync. Runs every minute (see vercel.json) so a new deposit
// shows up in the dashboard within ~1 minute instead of waiting for the full
// 15-minute sync. Only touches the deposits table.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const entry = SHEET_MAP.find((s) => s.table === "deposits");
  if (!entry) {
    return NextResponse.json({ error: "deposits sheet not mapped" }, { status: 500 });
  }

  const result = await syncOneSheet(entry.spreadsheetId, entry.sheetName, entry.table);
  return NextResponse.json({ timestamp: new Date().toISOString(), result });
}
