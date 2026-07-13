import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";

// Client sub-accounts whose GoHighLevel sync has stalled — no error-free poll in
// over this many days, so new leads stop appearing across the dashboard until
// the account is reconnected. Admin only.
//
// Signal = ghl_sync_status.last_success_at, which the ingest advances on every
// clean run regardless of lead volume — so a quiet-but-healthy account never
// looks stale (unlike contact timestamps), and an account that's failing or was
// dropped from the roster keeps its old timestamp and gets flagged.
const STALE_DAYS = 2;

type Row = { owner_key: string; last_success_at: string | null; last_attempt_at: string | null; error: string | null; muted: boolean | null };

export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const svc = createServiceClient();
  const cutoff = new Date(Date.now() - STALE_DAYS * 86400000).toISOString();

  // Stalled = a recorded, un-muted account whose last clean poll is missing or
  // past the cutoff. Muted = known-broken on purpose (admin clicked Ignore).
  const { data } = await svc
    .from("ghl_sync_status")
    .select("owner_key, last_success_at, last_attempt_at, error, muted")
    .or(`last_success_at.is.null,last_success_at.lt.${cutoff}`);
  const rows = ((data ?? []) as Row[]).filter((r) => !r.muted);

  // Resolve owner_key → business name + client status. Only LIVE clients are
  // flagged: paused clients (e.g. disconnected sub-accounts) aren't expected to
  // sync, and their missing data doesn't matter to the team.
  const bizByOwner = new Map<string, { business: string; live: boolean }>();
  if (rows.length) {
    const { data: cm } = await svc.from("clients_master").select("data");
    for (const r of (cm ?? []) as Array<{ data: Record<string, unknown> }>) {
      const owner = String(r.data?.["Owner Full Name"] ?? "").trim().toLowerCase();
      const biz = String(r.data?.["Business Name"] ?? "").trim();
      const live = String(r.data?.["col_1"] ?? "").trim().toLowerCase() === "live";
      if (owner && !bizByOwner.has(owner)) bizByOwner.set(owner, { business: biz || owner, live });
    }
  }

  const ms = (s: string | null) => (s ? Date.parse(s) : 0);
  const stalled = rows
    .filter((r) => bizByOwner.get(r.owner_key)?.live === true)
    .map((r) => ({
      ownerKey: r.owner_key,
      business: bizByOwner.get(r.owner_key)?.business ?? r.owner_key,
      lastSuccessAt: r.last_success_at,
      error: r.error,
    }))
    .sort((a, b) => ms(a.lastSuccessAt) - ms(b.lastSuccessAt));

  return NextResponse.json({ staleDays: STALE_DAYS, stalled });
}
