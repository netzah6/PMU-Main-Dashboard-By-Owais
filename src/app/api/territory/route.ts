import { NextRequest, NextResponse } from "next/server";

const UA = "PMU-Territory-Map/1.0 (pmu-bookings dashboard)";

// Public endpoint: geocode a zip/place, then find real PMU / beauty businesses
// nearby from OpenStreetMap (Overpass). Returns the center + competitor dots.
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") || req.nextUrl.searchParams.get("zip") || "").trim();
  const milesParam = Number(req.nextUrl.searchParams.get("miles") || "15");
  const radiusM = Math.max(3, Math.min(50, milesParam)) * 1609; // 3–50 mi → meters
  if (!q) return NextResponse.json({ error: "Enter a zip code or city" }, { status: 400 });

  try {
    const geo = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(q)}`,
      { headers: { "User-Agent": UA }, next: { revalidate: 86400 } }
    );
    const gj = (await geo.json()) as Array<{ lat: string; lon: string; display_name: string }>;
    if (!gj?.[0]) return NextResponse.json({ error: "Couldn't find that location — try a zip code." }, { status: 404 });
    const lat = parseFloat(gj[0].lat), lng = parseFloat(gj[0].lon);
    const label = gj[0].display_name;

    const ql = `[out:json][timeout:25];(` +
      `node["shop"="beauty"](around:${radiusM},${lat},${lng});` +
      `way["shop"="beauty"](around:${radiusM},${lat},${lng});` +
      `node["shop"="tattoo"](around:${radiusM},${lat},${lng});` +
      `nwr["name"~"permanent makeup|microblading|micropigment|pmu|powder brow|ombre brow|brow bar|lash & brow",i](around:${radiusM},${lat},${lng});` +
      `);out center 400;`;
    const ov = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
      body: "data=" + encodeURIComponent(ql),
      next: { revalidate: 86400 },
    });
    const oj = (await ov.json()) as { elements?: Array<Record<string, unknown>> };

    const seen = new Set<string>();
    const artists = (oj.elements ?? [])
      .map((e) => {
        const center = e.center as { lat?: number; lon?: number } | undefined;
        const la = (e.lat as number) ?? center?.lat;
        const lo = (e.lon as number) ?? center?.lon;
        const tags = (e.tags as Record<string, string>) ?? {};
        const name = tags.name;
        return la != null && lo != null && name ? { name, lat: la, lng: lo } : null;
      })
      .filter((a): a is { name: string; lat: number; lng: number } => !!a)
      .filter((a) => { const k = a.name.toLowerCase().trim(); if (seen.has(k)) return false; seen.add(k); return true; });

    return NextResponse.json({ center: { lat, lng, label }, miles: Math.round(radiusM / 1609), count: artists.length, artists });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
