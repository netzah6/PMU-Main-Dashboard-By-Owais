import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { refreshOneboxConfig, normalizeElfsight, harvestPixelId, ensureOneboxCustomValues, setOneboxCustomValues, ONEBOX_EDITABLE_CVS } from "@/lib/onebox";

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
  oldFunnelUrl?: string;
  ownerName?: string;
};

// Public funnel URL on the branded domain (book.pmu-care.com is a
// CNAME onto this same Vercel deployment; middleware rewrites the
// short path to /f/<slug> on that host).
const FUNNEL_ORIGIN = "https://book.pmu-care.com";

function funnelUrl(_req: NextRequest, slug: string): string {
  return `${FUNNEL_ORIGIN}/${slug}`;
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

  const [{ data: leads }, { data: hitRows }] = await Promise.all([
    svc.from("onebox_leads").select("slug, ghl_status, created_at"),
    svc.from("onebox_hits").select("slug"),
  ]);
  const hitCounts: Record<string, number> = {};
  for (const hRow of hitRows ?? []) hitCounts[hRow.slug] = (hitCounts[hRow.slug] ?? 0) + 1;

  const counts: Record<string, { leads: number; booked: number; paid: number; lastLeadAt: string | null }> = {};
  for (const l of leads ?? []) {
    const c = (counts[l.slug] ??= { leads: 0, booked: 0, paid: 0, lastLeadAt: null });
    c.leads++;
    if (l.ghl_status === "booked") c.booked++;
    if (l.ghl_status === "booked" || l.ghl_status === "paid" || l.ghl_status === "paid-not-booked") c.paid++;
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
      hasFanbasis: !!(config.fanbasisProductId || config.fanbasisCode || extras.fanbasisHtml),
      hasWidget: !!(config.igWidget || config.googleWidget || config.elfsightId || extras.elfsightId || config.resultImgs || extras.resultImgs),
      hasPixel: !!((config.metaPixelId || extras.metaPixelId || "").replace(/\D/g, "")),
      oldFunnelUrl: extras.oldFunnelUrl ?? "",
      cv: Object.fromEntries(Object.keys(ONEBOX_EDITABLE_CVS).map((k) => [k, config[k] ?? ""])),
      visitors: hitCounts[r.slug] ?? 0,
      leads: counts[r.slug]?.leads ?? 0,
      booked: counts[r.slug]?.booked ?? 0,
      paid: counts[r.slug]?.paid ?? 0,
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
      extras.oldFunnelUrl = oldUrl;
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
    // Older sub-accounts miss the one-box custom values — create the
    // absent ones (empty) so the team only has to fill values in GHL.
    const ensured = await ensureOneboxCustomValues(locationId);
    const config = await refreshOneboxConfig(svc, slug, locationId);
    return NextResponse.json({
      ok: true, slug, url: funnelUrl(req, slug), pixelNote,
      cvNote: ensured.created.length
        ? `created ${ensured.created.length} missing custom values: ${ensured.created.join(", ")} — fill them in GHL`
        : "all one-box custom values already existed",
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
    if (body.oldFunnelUrl !== undefined) extras.oldFunnelUrl = String(body.oldFunnelUrl).trim();
    if (body.ownerName !== undefined) extras.ownerName = String(body.ownerName).trim();
    await svc.from("onebox_clients").update({ extras, updated_at: new Date().toISOString() }).eq("slug", slug);
    return NextResponse.json({ ok: true, elfsightId: extras.elfsightId ?? "" });
  }

  if (action === "cvs") {
    // Write the submitted values straight into the sub-account's custom
    // values, then resync so the funnel reflects them immediately.
    let values: Record<string, unknown> = {};
    try { values = JSON.parse(String(body.values ?? "{}")); } catch { /* empty */ }
    const entries: { name: string; value: string }[] = [];
    for (const [key, cvName] of Object.entries(ONEBOX_EDITABLE_CVS)) {
      if (key in values && typeof values[key] === "string") {
        entries.push({ name: cvName, value: (values[key] as string).trim().slice(0, 2000) });
      }
    }
    if (!entries.length) return NextResponse.json({ error: "no values" }, { status: 400 });
    const res = await setOneboxCustomValues(row.location_id as string, entries);
    if (res.error) return NextResponse.json({ error: `GHL write failed (${res.error})` }, { status: 502 });
    const config = await refreshOneboxConfig(svc, slug, row.location_id as string);
    return NextResponse.json({ ok: true, written: res.written.length, config });
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

    const fbPid = (config.fanbasisProductId || "").trim();
    const fbCode = (config.fanbasisCode || "").trim() || extras.fanbasisHtml || "";
    checks.push({
      name: "Fanbasis checkout",
      ok: !!(fbPid || fbCode),
      note: fbPid ? `product ${fbPid} (custom value)` : fbCode ? `${fbCode.length} chars` : "add 'CC - Fanbasis Product ID' custom value",
    });
    const pixel = (config.metaPixelId || extras.metaPixelId || "").replace(/\D/g, "");
    checks.push({ name: "Meta pixel", ok: !!pixel, note: pixel ? `pixel ${pixel}` : "no pixel — harvest or set OB - Meta Pixel ID" });
    // Which required values are still empty on the account.
    const requiredCfg: [string, string][] = [
      ["biz", "Business Name"], ["phone", "CC - Business Phone Number"],
      ["address", "CC - Full Business Address"], ["offer", "CC - Offer"],
      ["calendarId", "CC - Permanent Makeup Transformation Calendar ID🔵"],
      ["fanbasisProductId", "CC - Fanbasis Product ID"],
    ];
    const missingCvs = requiredCfg.filter(([k]) => !(config[k] ?? "").trim()).map(([, n]) => n);
    checks.push({
      name: "Custom values",
      ok: missingCvs.length === 0,
      note: missingCvs.length ? `empty or missing: ${missingCvs.join(", ")}` : "all required values filled",
    });
    const syncAge = row.cv_synced_at ? Date.now() - new Date(row.cv_synced_at as string).getTime() : Infinity;
    checks.push({ name: "GHL content sync", ok: syncAge < 30 * 60000, note: row.cv_synced_at ? `synced ${Math.round(syncAge / 60000)}m ago` : "never synced" });

    return NextResponse.json({ ok: checks.every((c) => c.ok), checks });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
