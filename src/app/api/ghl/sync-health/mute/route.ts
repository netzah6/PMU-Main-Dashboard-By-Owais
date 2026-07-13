import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";

// Admin: mute/unmute one account in the sync-health banner. Muted = the account
// is known-broken on purpose (e.g. a client we've chosen not to reconnect) and
// shouldn't nag. The ingest keeps attempting it daily, so if it ever reconnects
// its data flows again automatically — mute only silences the banner.
export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const b = (await req.json().catch(() => ({}))) as { ownerKey?: string; muted?: boolean };
  const ownerKey = String(b.ownerKey ?? "").trim().toLowerCase();
  if (!ownerKey) return NextResponse.json({ error: "ownerKey required" }, { status: 400 });
  const muted = b.muted !== false; // default: mute

  const svc = createServiceClient();
  const { error } = await svc
    .from("ghl_sync_status")
    .update({ muted, updated_at: new Date().toISOString() })
    .eq("owner_key", ownerKey);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, ownerKey, muted });
}
