import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken } from "@/lib/ghl-app";

// Real availability for a one-box funnel's calendar: proxies GHL's
// free-slots API (the same source the booking widget uses) so the page
// can render its own date & time picker with zero extra form steps.
export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("slug") ?? "";
  const start = Number(req.nextUrl.searchParams.get("start") ?? 0);
  const end = Number(req.nextUrl.searchParams.get("end") ?? 0);
  if (!slug || !start || !end || end <= start || end - start > 45 * 86400000) {
    return NextResponse.json({ ok: false, error: "bad range" }, { status: 400 });
  }

  const svc = createServiceClient();
  const { data: client } = await svc
    .from("onebox_clients")
    .select("slug, location_id, status, config")
    .eq("slug", slug)
    .single();
  const calendarId = (client?.config as Record<string, string>)?.calendarId;
  if (!client || client.status === "draft" || !calendarId) {
    return NextResponse.json({ ok: false, error: "unknown funnel" }, { status: 404 });
  }

  const tok = await getAppLocationToken(client.location_id as string);
  if (!tok.token) {
    return NextResponse.json({ ok: false, error: "no token" }, { status: 502 });
  }

  const r = await fetch(
    `https://services.leadconnectorhq.com/calendars/${encodeURIComponent(calendarId)}/free-slots?startDate=${start}&endDate=${end}`,
    { headers: { Authorization: `Bearer ${tok.token}`, Version: "2021-04-15", Accept: "application/json" } }
  );
  if (!r.ok) {
    return NextResponse.json({ ok: false, error: `free-slots ${r.status}` }, { status: 502 });
  }
  const j = (await r.json()) as Record<string, { slots?: string[] }>;

  // Normalize: { "2026-08-19": ["2026-08-19T10:00:00-07:00", ...], ... }
  const dates: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(j)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(k) && Array.isArray(v?.slots)) dates[k] = v.slots;
  }
  return NextResponse.json({ ok: true, dates });
}
