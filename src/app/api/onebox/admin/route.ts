import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { refreshOneboxConfig, normalizeElfsight, harvestPixelId } from "@/lib/onebox";

// Never serve cached fetches: Supabase rows and GHL availability must be live.
export const fetchCache = "force-no-store";

export const maxDuration = 120;

// Funnels tab (admin only): manage the one-box funnels.
//   GET                       → all funnels + lead/booking counts
//   POST {action:"add", slug, locationId, clientName, oldFunnelUrl?}
//   POST {action:"resync", slug}
//   POST {action:"extras", slug, fanbasisHtml?, elfsightId?, resultImgs?, metaPixelId?}
//   POST {action:"status", slug, status}         (live | paused)
//   POST {action:"health", slug}                 → live checks for one funnel

type Extras = {
  faqs?: { q: string; a: string }[];
  fanbasisHtml?: string;
  elfsightId?: string;
  resultImgs?: string;
  metaPixelId?: string;
};

function funnelUrl(req: NextRequest, slug: string): string {
  return `${req.nextUrl.origin}/f/${slug}`;
}

export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const svc = createServiceClient();
  const { data: rows } = await svc
    .from("onebox_clients")
    .select("slug, location_id, client_name, status, cv_synced_at, config, extras, created_at")
    .order("created_at", { ascending: true });

  const { data: leads } = await svc
    .from("onebox_leads")
    .select("slug, ghl_status, created_at");

  const counts: Record<string, { leads: number; booked: number; lastLeadAt: string | null }> = {};
  for (const l of leads ?? []) {
    const c = (counts[l.slug] ??= { leads: 0, booked: 0, lastLeadAt: null });
    c.leads++;
    if (l.ghl_status === "booked") c.booked++;
    if (!c.lastLeadAt || l.created_at > c.lastLeadAt) c.lastLeadAt = l.created_at;
  }

  const out = (rows ?? []).map((r) => {
    const extras = (r.extras ?? {}) as Extras;
    const config = (r.config ?? {}) as Record<string, string>;
    return {
      slug: r.slug,
      locationId: r.location_id,
      clientName: r.client_name,
      status: r.status,
      cvSyncedAt: r.cv_synced_at,
      url: funnelUrl(req, r.slug),
      hasCalendar: !!config.calendarId,
      hasFanbasis: !!extras.fanbasisHtml,
      hasWidget: !!(config.elfsightId || extras.elfsightId || config.resultImgs || extras.resultImgs),
      hasPixel: !!((config.metaPixelId || extras.metaPixelId || "").replace(/\D/g, "")),
      leads: counts[r.slug]?.leads ?? 0,
      booked: counts[r.slug]?.booked ?? 0,
      lastLeadAt: counts[r.slug]?.lastLeadAt ?? null,
    };
  });
  return NextResponse.json({ funnels: out });
}

export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const svc = createServiceClient();
  const action = String(body.action ?? "");
  const slug = String(body.slug ?? "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

  if (action === "add") {
    const locationId = String(body.locationId ?? "").trim();
    if (!slug || !locationId) return NextResponse.json({ error: "slug and locationId required" }, { status: 400 });
    const { data: existing } = await svc.from("onebox_clients").select("slug").eq("slug", slug).maybeSingle();
    if (existing) return NextResponse.json({ error: `slug "${slug}" already exists` }, { status: 409 });

    // Meta pixel: harvest from the client's existing live funnel page.
    const extras: Extras = {};
    let pixelNote = "no old funnel URL given — add the pixel later";
    const oldUrl = String(body.oldFunnelUrl ?? "").trim();
    if (oldUrl) {
      const pixel = await harvestPixelId(oldUrl);
      if (pixel) { extras.metaPixelId = pixel; pixelNote = `pixel ${pixel} harvested from ${oldUrl}`; }
      else pixelNote = `no pixel found on ${oldUrl} — set it manually`;
    }

    await svc.from("onebox_clients").insert({
      slug,
      location_id: locationId,
      client_name: String(body.clientName ?? "").trim(),
      status: "paused",
      extras,
    });
    const config = await refreshOneboxConfig(svc, slug, locationId);
    return NextResponse.json({
      ok: true, slug, url: funnelUrl(req, slug), pixelNote,
      synced: !!config, calendarId: config?.calendarId ?? "",
    });
  }

  if (!slug) return NextResponse.json({ error: "slug required" }, { status: 400 });
  const { data: row } = await svc.from("onebox_clients").select("*").eq("slug", slug).single();
  if (!row) return NextResponse.json({ error: "unknown slug" }, { status: 404 });

  if (action === "resync") {
    const config = await refreshOneboxConfig(svc, slug, row.location_id as string);
    return NextResponse.json({ ok: !!config, config });
  }

  if (action === "status") {
    const status = body.status === "live" ? "live" : "paused";
    await svc.from("onebox_clients").update({ status, updated_at: new Date().toISOString() }).eq("slug", slug);
    return NextResponse.json({ ok: true, status });
  }

  if (action === "extras") {
    const extras = { ...(row.extras as Extras) };
    if (body.fanbasisHtml !== undefined) extras.fanbasisHtml = String(body.fanbasisHtml);
    if (body.elfsightId !== undefined) extras.elfsightId = normalizeElfsight(body.elfsightId);
    if (body.resultImgs !== undefined) extras.resultImgs = String(body.resultImgs);
    if (body.metaPixelId !== undefined) extras.metaPixelId = String(body.metaPixelId).replace(/\D/g, "");
    await svc.from("onebox_clients").update({ extras, updated_at: new Date().toISOString() }).eq("slug", slug);
    return NextResponse.json({ ok: true, elfsightId: extras.elfsightId ?? "" });
  }

  if (action === "health") {
    const config = (row.config ?? {}) as Record<string, string>;
    const extras = (row.extras ?? {}) as Extras;
    const checks: { name: string; ok: boolean; note: string }[] = [];

    // page serves
    let pageOk = false;
    try {
      const r = await fetch(funnelUrl(req, slug), { signal: AbortSignal.timeout(15000) });
      pageOk = r.ok && (await r.text()).includes("onebox-root");
    } catch { /* stays false */ }
    checks.push({ name: "Funnel page loads", ok: pageOk, note: pageOk ? "200 OK" : row.status === "draft" ? "status is draft" : "page failed to load" });

    // availability
    let slotsOk = false, slotNote = "";
    if (config.calendarId) {
      try {
        const start = Date.now(), end = start + 21 * 86400000;
        const r = await fetch(`${req.nextUrl.origin}/api/onebox/slots?slug=${slug}&start=${start}&end=${end}`, { signal: AbortSignal.timeout(20000) });
        const j = (await r.json()) as { ok?: boolean; dates?: Record<string, string[]> };
        const days = Object.keys(j.dates ?? {}).length;
        slotsOk = !!j.ok && days > 0;
        slotNote = slotsOk ? `${days} days with open times` : "no available slots returned";
      } catch { slotNote = "availability check failed"; }
    } else slotNote = "no calendar id in custom values";
    checks.push({ name: "Calendar availability", ok: slotsOk, note: slotNote });

    checks.push({ name: "Fanbasis checkout block", ok: !!extras.fanbasisHtml, note: extras.fanbasisHtml ? `${extras.fanbasisHtml.length} chars` : "paste the client's Fanbasis block" });
    const pixel = (config.metaPixelId || extras.metaPixelId || "").replace(/\D/g, "");
    checks.push({ name: "Meta pixel", ok: !!pixel, note: pixel ? `pixel ${pixel}` : "no pixel — harvest or set OB - Meta Pixel ID" });
    const syncAge = row.cv_synced_at ? Date.now() - new Date(row.cv_synced_at as string).getTime() : Infinity;
    checks.push({ name: "GHL content sync", ok: syncAge < 30 * 60000, note: row.cv_synced_at ? `synced ${Math.round(syncAge / 60000)}m ago` : "never synced" });

    return NextResponse.json({ ok: checks.every((c) => c.ok), checks });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
