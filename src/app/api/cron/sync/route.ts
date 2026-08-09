import { NextRequest, NextResponse } from "next/server";
import { syncAllSheets } from "@/lib/sync";
import { syncPayments } from "@/lib/payments";
import { refreshOffers } from "@/lib/offers";
import { trackVersionChanges } from "@/lib/version-track";

export const maxDuration = 300; // Vercel: allow up to 5 min for full sync

export async function GET(req: NextRequest) {
  // Vercel Cron sends the secret as a Bearer token
  const authHeader = req.headers.get("authorization");
  if (
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ?only=offers|payments runs a single job. syncAllSheets can consume the whole
  // 300s budget on the slow workbook, so without this there is no way to run the
  // cheap jobs on demand — a full run just times out before reaching them.
  const only = req.nextUrl.searchParams.get("only");

  // Cheap jobs FIRST. Anything sequenced after syncAllSheets is starved whenever
  // the sheet read eats the budget: that is how client_payments sat on the June
  // tab for two weeks of July, and how refreshOffers silently stopped running.
  const payments = only && only !== "payments" ? null : await syncPayments();
  const offers = only && only !== "offers" ? null : await refreshOffers();
  if (only) {
    return NextResponse.json({ timestamp: new Date().toISOString(), only, payments, offers });
  }

  const results = await syncAllSheets();
  // After the master mirror is fresh: auto-log any V3/V2.3 switches into the
  // Activity & Changes Log (shows in the log + pins 📌 on the timeline).
  const versionChanges = await trackVersionChanges();

  const errors = results.filter((r) => r.status === "error");
  const totalSynced = results.reduce((s, r) => s + r.supabaseRowsAfter, 0);

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    totalSynced,
    results,
    payments,
    offers,
    versionChanges,
    errors: errors.length,
  });
}

// Allow manual POST trigger from dashboard UI (admin only)
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const { table } = body as { table?: string };

  if (table) {
    // Sync a single table
    const { SHEET_MAP } = await import("@/lib/sheets");
    const { syncOneSheet } = await import("@/lib/sync");
    const entry = SHEET_MAP.find((s) => s.table === table);
    if (!entry) {
      return NextResponse.json({ error: `Unknown table: ${table}` }, { status: 400 });
    }
    const result = await syncOneSheet(entry.spreadsheetId, entry.sheetName, entry.table);
    return NextResponse.json({ results: [result] });
  }

  // Sync all (payments first — see GET)
  const payments = await syncPayments();
  const results = await syncAllSheets();
  return NextResponse.json({
    timestamp: new Date().toISOString(),
    results,
    payments,
    errors: results.filter((r) => r.status === "error").length,
  });
}
