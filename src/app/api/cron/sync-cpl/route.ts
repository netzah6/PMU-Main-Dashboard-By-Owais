import { NextRequest, NextResponse } from "next/server";
import { SHEET_MAP } from "@/lib/sheets";
import { syncOneSheet } from "@/lib/sync";

export const maxDuration = 120;

// Dedicated sync for the Facebook Campaign Stats workbook (CPL 7/14/30 +
// campaign spend). These four tabs sit LAST in the full sync's sequential
// list, so whenever the slow workbook eats the 300s budget they starve — that
// is exactly how Performance showed Aug-20 CPLs on Aug 25 (Martha Jones
// report). Small tabs, own schedule, immune to everyone else's slowness —
// same pattern as sync-deposits.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const tables = ["cpl_7days", "cpl_14days", "cpl_30days", "campaign_spent"];
  const results = [];
  for (const t of tables) {
    const entry = SHEET_MAP.find((s) => s.table === t);
    if (!entry) continue;
    results.push(await syncOneSheet(entry.spreadsheetId, entry.sheetName, entry.table, entry.fallbackIndex));
  }
  return NextResponse.json({ timestamp: new Date().toISOString(), results });
}
