import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { getV3Accounts, ingestAccount } from "@/lib/ghl-ingest";

export const maxDuration = 300;

// Admin: re-pull one account's full history from GoHighLevel right now — used
// after reconnecting a stalled sub-account to backfill every missed lead
// without waiting for the daily cron. A clean run clears its sync-health flag.
export async function POST(req: Request) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { ownerKey } = (await req.json().catch(() => ({}))) as { ownerKey?: string };
  const key = (ownerKey ?? "").trim().toLowerCase();
  if (!key) return NextResponse.json({ error: "ownerKey is required" }, { status: 400 });

  const acct = (await getV3Accounts()).find((a) => a.ownerKey === key);
  if (!acct) {
    return NextResponse.json(
      { error: "This account isn't reachable from GoHighLevel — reconnect the marketplace app on its sub-account first, then resync." },
      { status: 404 }
    );
  }

  // Full history (no incremental window) so nothing from the outage is missed.
  const stat = await ingestAccount(acct, {});
  if (stat.error) return NextResponse.json({ error: stat.error, stat }, { status: 502 });

  // Refresh the derived views so the recovered leads show across the dashboard.
  const svc = createServiceClient();
  await svc.rpc("refresh_booking_stats").then(() => {}, () => {});
  await svc.rpc("refresh_ppa_facts").then(() => {}, () => {});

  return NextResponse.json({ stat });
}
