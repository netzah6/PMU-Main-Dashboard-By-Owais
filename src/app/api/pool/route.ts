import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { poolReadiness, syncPool, type PoolRow } from "@/lib/ghl-cleanup";

export const maxDuration = 60;

// Which clean accounts are actually usable for a setup.
//
// Open to any signed-in team member — it's read-only inventory, and the people
// running setups need it more than admins do. (The Cleanup tab's own pool
// endpoint stays admin-only because it can wipe and rename accounts.)
//
// The list is a TABLE, and until 2026-09-29 only the admin Cleanup tab ever
// re-read GoHighLevel into it — so the Onboarding panel said 65 accounts for
// two months while 29 of them had been claimed, and its Refresh button just
// re-read the same stale rows. Now ?sync=1 (the Refresh button) re-checks
// GHL first, and a plain load does the same whenever the table is over an
// hour old. Syncing only marks renamed accounts as used — nothing in GHL
// is touched.
export async function GET(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const svc = createServiceClient();
  const force = req.nextUrl.searchParams.get("sync") === "1";
  let synced = false;
  let syncError: string | null = null;
  const { data: newest } = await svc
    .from("pool_accounts").select("last_checked_at")
    .order("last_checked_at", { ascending: false }).limit(1).maybeSingle();
  const lastChecked = (newest as { last_checked_at?: string } | null)?.last_checked_at ?? null;
  const stale = !lastChecked || Date.now() - Date.parse(lastChecked) > 60 * 60 * 1000;
  if (force || stale) {
    try { await syncPool(); synced = true; }
    catch (e) { syncError = e instanceof Error ? e.message : "sync failed"; }
  }

  const { data, error } = await svc
    .from("pool_accounts").select("*")
    .eq("status", "available")
    .order("pool_name", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as PoolRow[];
  const withState = rows.map((r) => ({
    location_id: r.location_id,
    pool_name: r.pool_name,
    a2p: r.a2p,
    workflows: r.workflows,
    clean_note: r.clean_note,
    clean_checked_at: r.clean_checked_at,
    readiness: poolReadiness(r),
    // Why this one isn't offered, in the words the team would use.
    blocker:
      poolReadiness(r) === "ready" ? null
        : r.clean_checked_at == null ? "not checked yet"
          : (r.dirty ?? 0) > 0 ? `still has data — ${r.clean_note}`
            : (r.workflows ?? 0) > 0 ? `${r.workflows} automations still in it`
              : "A2P not confirmed",
  }));

  // Sort so the lowest-numbered ready account is the obvious one to take next.
  const num = (n: string) => Number(n.replace(/\D+/g, "")) || 0;
  const ready = withState.filter((r) => r.readiness === "ready").sort((a, b) => num(a.pool_name) - num(b.pool_name));
  const notReady = withState.filter((r) => r.readiness !== "ready").sort((a, b) => num(a.pool_name) - num(b.pool_name));

  return NextResponse.json({
    ready,
    notReady,
    counts: { ready: ready.length, notReady: notReady.length, total: withState.length },
    synced,
    syncError,
    checkedAt: synced ? new Date().toISOString() : lastChecked,
  });
}
