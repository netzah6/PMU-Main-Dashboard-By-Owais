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

type Row = { owner_key: string; last_success_at: string | null; last_attempt_at: string | null; error: string | null };

export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const svc = createServiceClient();
  const cutoff = new Date(Date.now() - STALE_DAYS * 86400000).toISOString();

  // Stalled = a recorded account whose last clean poll is missing or past the cutoff.
  const { data } = await svc
    .from("ghl_sync_status")
    .select("owner_key, last_success_at, last_attempt_at, error")
    .or(`last_success_at.is.null,last_success_at.lt.${cutoff}`);
  const rows = (data ?? []) as Row[];

  // Resolve owner_key → business name for a recognizable label.
  const bizByOwner = new Map<string, string>();
  if (rows.length) {
    const { data: cm } = await svc.from("clients_master").select("data");
    for (const r of (cm ?? []) as Array<{ data: Record<string, unknown> }>) {
      const owner = String(r.data?.["Owner Full Name"] ?? "").trim().toLowerCase();
      const biz = String(r.data?.["Business Name"] ?? "").trim();
      if (owner && biz && !bizByOwner.has(owner)) bizByOwner.set(owner, biz);
    }
  }

  const ms = (s: string | null) => (s ? Date.parse(s) : 0);
  const stalled = rows
    .map((r) => ({
      ownerKey: r.owner_key,
      business: bizByOwner.get(r.owner_key) ?? r.owner_key,
      lastSuccessAt: r.last_success_at,
      error: r.error,
    }))
    .sort((a, b) => ms(a.lastSuccessAt) - ms(b.lastSuccessAt));

  return NextResponse.json({ staleDays: STALE_DAYS, stalled });
}
