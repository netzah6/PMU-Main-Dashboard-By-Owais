import { NextRequest, NextResponse } from "next/server";
import { syncAllSheets } from "@/lib/sync";
import { syncPayments } from "@/lib/payments";
import { refreshOffers } from "@/lib/offers";

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

  // Payments first: it's one tab read + one upsert, and running it after the
  // full sheet sync starved it whenever syncAllSheets ate the 300s budget
  // (client_payments sat on the June tab for two weeks of July).
  const payments = await syncPayments();
  const results = await syncAllSheets();
  const offers = await refreshOffers();

  const errors = results.filter((r) => r.status === "error");
  const totalSynced = results.reduce((s, r) => s + r.supabaseRowsAfter, 0);

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    totalSynced,
    results,
    payments,
    offers,
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
