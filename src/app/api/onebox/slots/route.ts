import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken } from "@/lib/ghl-app";

// Never serve cached fetches: Supabase rows and GHL availability must be live.
export const fetchCache = "force-no-store";

// Real availability for a one-box funnel's calendar: proxies GHL's
// free-slots API (the same source the booking widget uses) so the page
// can render its own date & time picker with zero extra form steps.

/* 30s in-process memo: warm lambdas answer repeat range requests from
   memory instead of re-running the Supabase -> token -> GHL chain. The
   engine rounds range starts to 5-min buckets, so keys actually repeat. */
const slotsMemo = new Map<string, { ts: number; body: { ok: true; dates: Record<string, string[]> } }>();

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("slug") ?? "";
  const start = Number(req.nextUrl.searchParams.get("start") ?? 0);
  const end = Number(req.nextUrl.searchParams.get("end") ?? 0);
  if (!slug || !start || !end || end <= start || end - start > 45 * 86400000) {
    return NextResponse.json({ ok: false, error: "bad range" }, { status: 400 });
  }

  const memoKey = `${slug}:${start}:${end}`;
  const hit = slotsMemo.get(memoKey);
  if (hit && Date.now() - hit.ts < 30_000) {
    return NextResponse.json(hit.body, { headers: CACHE_HEADERS });
  }

  const svc = createServiceClient();
  const { data: client } = await svc
    .from("onebox_clients")
    .select("slug, location_id, status, config, extras")
    .eq("slug", slug)
    .single();
  const extras = (client?.extras ?? {}) as { template?: string; b2b?: { calendarId?: string } };
  const calendarId = extras.template === "b2b"
    ? extras.b2b?.calendarId
    : (client?.config as Record<string, string>)?.calendarId;
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
  const body = { ok: true as const, dates };
  slotsMemo.set(memoKey, { ts: Date.now(), body });
  if (slotsMemo.size > 500) {
    for (const [k, v] of slotsMemo) if (Date.now() - v.ts > 30_000) slotsMemo.delete(k);
  }
  return NextResponse.json(body, { headers: CACHE_HEADERS });
}

/* Availability barely moves within a minute and double-booking is already
   prevented at appointment creation. Next.js overwrites a plain
   Cache-Control on dynamic route handlers (verified live), so the edge
   TTL rides the Vercel-specific header instead. */
const CACHE_HEADERS = {
  "Vercel-CDN-Cache-Control": "max-age=30, stale-while-revalidate=120",
};
