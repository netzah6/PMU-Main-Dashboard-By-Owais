import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { auditClient, type PixelCheckRow } from "@/lib/pixel-check";

// Pixel Checking — per-client funnel pixel/conversion audit. Admin only.
// GET → all rows. POST {locationId} → live re-crawl of that client's funnel
// pages (writes the fresh result back). POST {discover:true} → audit Live
// clients that have no row yet (new sign-ups), a few per call.

export const maxDuration = 300;

async function requireAdmin() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const svc = createServiceClient();
  const { data: role } = await svc.from("user_roles").select("role").eq("user_id", user.id).maybeSingle();
  if (role?.role !== "admin") return { error: NextResponse.json({ error: "Admins only" }, { status: 403 }) };
  return { user, svc };
}

export async function GET() {
  const gate = await requireAdmin();
  if ("error" in gate) return gate.error;
  const { data, error } = await gate.svc
    .from("pixel_checks")
    .select("*")
    .order("business_name", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rows: (data ?? []) as PixelCheckRow[] });
}

export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if ("error" in gate) return gate.error;
  const { svc } = gate;
  const body = await req.json().catch(() => ({}));

  // Re-check one client live.
  if (typeof body.locationId === "string" && body.locationId) {
    const { data: existing } = await svc
      .from("pixel_checks")
      .select("business_name, owner_name, entry_url")
      .eq("location_id", body.locationId)
      .maybeSingle();
    if (!existing) return NextResponse.json({ error: "Unknown location" }, { status: 404 });
    const fresh = await auditClient({
      svc,
      locationId: body.locationId,
      businessName: existing.business_name,
      ownerName: existing.owner_name,
      // Re-discover from attributions when the stored entry has gone stale.
      entryUrl: body.rediscover ? null : existing.entry_url,
    });
    const { error } = await svc.from("pixel_checks").upsert(fresh, { onConflict: "location_id" });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ row: fresh });
  }

  // Audit Live clients that have no row yet (new sign-ups since the last sweep).
  if (body.discover === true) {
    const { data: master } = await svc.from("clients_master").select("data");
    const { data: have } = await svc.from("pixel_checks").select("location_id, business_name");
    const haveBiz = new Set((have ?? []).map((r) => (r.business_name as string).trim().toLowerCase()));
    const live = ((master ?? []) as Array<{ data: Record<string, string> }>)
      .map((r) => r.data)
      .filter((d) => (d?.col_1 ?? "").trim().toLowerCase() === "live")
      .filter((d) => !haveBiz.has((d["Business Name"] ?? "").trim().toLowerCase()));
    if (!live.length) return NextResponse.json({ added: [], remaining: 0 });

    // Business name → location id via the GHL locations the OAuth app can see.
    const { data: oauth } = await svc.from("ghl_oauth").select("access_token, company_id").eq("id", 1).maybeSingle();
    if (!oauth?.access_token) return NextResponse.json({ error: "No GHL agency token" }, { status: 500 });
    const norm = (s: string) => s.toLowerCase().replace(/’|‘/g, "'").replace(/[^a-z0-9]+/g, "");
    const locByName = new Map<string, string>();
    for (let skip = 0; skip < 700; skip += 100) {
      const r = await fetch(
        `https://services.leadconnectorhq.com/locations/search?companyId=${oauth.company_id}&limit=100&skip=${skip}`,
        { headers: { Authorization: `Bearer ${oauth.access_token}`, Version: "2021-07-28" }, cache: "no-store" }
      );
      if (!r.ok) break;
      const j = (await r.json()) as { locations?: Array<{ id: string; name: string }> };
      for (const l of j.locations ?? []) locByName.set(norm(l.name), l.id);
      if ((j.locations ?? []).length < 100) break;
    }

    const added: PixelCheckRow[] = [];
    for (const d of live.slice(0, 5)) {
      const biz = (d["Business Name"] ?? "").trim();
      const lid = locByName.get(norm(biz));
      if (!lid) continue;
      const fresh = await auditClient({ svc, locationId: lid, businessName: d["Business Name"], ownerName: d["Owner Full Name"] ?? null });
      await svc.from("pixel_checks").upsert(fresh, { onConflict: "location_id" });
      added.push(fresh);
    }
    return NextResponse.json({ added, remaining: Math.max(0, live.length - 5) });
  }

  return NextResponse.json({ error: "Bad request" }, { status: 400 });
}
