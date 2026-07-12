import { NextRequest, NextResponse } from "next/server";
import { getV3Accounts, ingestAccount, ingestAllV3 } from "@/lib/ghl-ingest";
import { createServiceClient } from "@/lib/supabase/server";

export const maxDuration = 300;

// booking_stats is a materialized view (live computation was ~7s and timed out
// in the browser); refresh it whenever fresh GHL data lands.
async function refreshBookingStats(): Promise<string | null> {
  try {
    const svc = createServiceClient();
    const { error } = await svc.rpc("refresh_booking_stats");
    // Fresh opportunities/stages also feed the V3 billing materialized view.
    await svc.rpc("refresh_ppa_facts");
    return error ? error.message : null;
  } catch (e) {
    return e instanceof Error ? e.message : "refresh failed";
  }
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ?owner=<substring> ingests just the matching account(s) — for testing.
  const owner = req.nextUrl.searchParams.get("owner");
  if (owner) {
    const accts = (await getV3Accounts()).filter((a) => a.ownerKey.includes(owner.toLowerCase()));
    const stats = [];
    for (const a of accts) stats.push(await ingestAccount(a));
    const refreshError = await refreshBookingStats();
    return NextResponse.json({ timestamp: new Date().toISOString(), accounts: accts.length, stats, refreshError });
  }

  // Default = incremental "recent only" (fast, fits the daily cron).
  // ?full=1 does the heavy full-history backfill (run manually).
  const full = req.nextUrl.searchParams.get("full") === "1";
  const opts = full ? {} : { sinceMs: Date.now() - 3 * 86400000, maxPages: 8 };
  const result = await ingestAllV3(opts);
  const refreshError = await refreshBookingStats();
  return NextResponse.json({ timestamp: new Date().toISOString(), mode: full ? "full" : "incremental", refreshError, ...result });
}
