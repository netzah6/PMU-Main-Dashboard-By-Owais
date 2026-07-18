import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";

// Toggle a "verified by hand" mark for a manual check (browser-only items
// like A2P / SMS compliance). Stored per sub-account; the check report
// upgrades those manual rows to ✓ with a note. on=false removes the mark.
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { locationId?: string; key?: string; on?: boolean; note?: string };
  const locationId = String(body.locationId ?? "").trim();
  const key = String(body.key ?? "").trim();
  if (!locationId || !key) return NextResponse.json({ error: "locationId and key required" }, { status: 400 });

  const svc = createServiceClient();
  if (body.on === false) {
    const { error } = await svc.from("onboarding_check_overrides").delete().eq("location_id", locationId).eq("check_key", key);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, on: false });
  }

  const note = String(body.note ?? "").trim() || null;
  const { error } = await svc.from("onboarding_check_overrides").upsert({
    location_id: locationId,
    check_key: key,
    note,
    verified_by: user.email ?? null,
    verified_at: new Date().toISOString(),
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const detail = `Verified by hand by ${(user.email ?? "").split("@")[0]} (${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })})${note ? ` — ${note}` : ""}`;
  return NextResponse.json({ ok: true, on: true, detail });
}
