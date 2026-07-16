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

  // Default = incremental, but the window is anchored PER ACCOUNT to its own
  // last successful sync (ghl_sync_status), so an account that was down
  // backfills its whole outage the moment it's reachable again — a fixed
  // look-back would permanently lose every lead older than the window.
  // ?full=1 does the heavy full-history backfill (run manually).
  const full = req.nextUrl.searchParams.get("full") === "1";
  // 240s budget: stop starting accounts well before maxDuration (300s) kills
  // the function, so every run returns clean stats and the view refresh runs.
  const opts = full ? {} : { anchorToLastSuccess: true, maxPages: 8, timeBudgetMs: 240_000 };
  const result = await ingestAllV3(opts);
  const refreshError = await refreshBookingStats();
  return NextResponse.json({ timestamp: new Date().toISOString(), mode: full ? "full" : "incremental", refreshError, ...result });
}
