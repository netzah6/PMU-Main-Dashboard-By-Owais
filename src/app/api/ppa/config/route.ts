import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";

// Set a V3 client's pay-per-appointment config (on/off flag, fee, note).
// Merges with any existing row so partial updates don't clobber other fields.
export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as {
    owner_key?: string; is_ppa?: boolean; fee?: number; note?: string;
  };
  const ownerKey = String(body.owner_key ?? "").trim().toLowerCase();
  if (!ownerKey) return NextResponse.json({ error: "owner_key required" }, { status: 400 });

  const svc = createServiceClient();
  const { data: existing } = await svc.from("ppa_config").select("*").eq("owner_key", ownerKey).maybeSingle();

  const row = {
    owner_key: ownerKey,
    is_ppa: body.is_ppa ?? (existing?.is_ppa ?? false),
    fee_per_appt: body.fee != null ? Number(body.fee) : (existing?.fee_per_appt ?? 30),
    note: body.note !== undefined ? body.note : (existing?.note ?? null),
    updated_at: new Date().toISOString(),
    updated_by: auth.email,
  };
  const { error } = await svc.from("ppa_config").upsert(row, { onConflict: "owner_key" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, config: row });
}
