import { NextRequest, NextResponse } from "next/server";
import { getV3Accounts, ingestAccount, ingestAllV3 } from "@/lib/ghl-ingest";

export const maxDuration = 300;

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
    return NextResponse.json({ timestamp: new Date().toISOString(), accounts: accts.length, stats });
  }

  // Default = incremental "recent only" (fast, fits the daily cron).
  // ?full=1 does the heavy full-history backfill (run manually).
  const full = req.nextUrl.searchParams.get("full") === "1";
  const opts = full ? {} : { sinceMs: Date.now() - 3 * 86400000, maxPages: 8 };
  const result = await ingestAllV3(opts);
  return NextResponse.json({ timestamp: new Date().toISOString(), mode: full ? "full" : "incremental", ...result });
}
