import { NextRequest } from "next/server";

// Immutable caching proxy for client logos. GHL's image service costs
// ~0.3-1.2s per request and is the slowest visible element on the funnel;
// behind this route the first visitor per edge region pays that once and
// everyone after is served from the CDN in ~30ms. The source URL is part
// of the cache key, so a changed logo is a new entry — immutable is safe.
// Host allowlist only — this must never become an open proxy.
export const maxDuration = 30;

const ALLOWED = /^https:\/\/(images\.leadconnectorhq\.com|assets\.cdn\.filesafe\.space|storage\.googleapis\.com\/msgsndr|services\.leadconnectorhq\.com)\//;
const MAX_BYTES = 3 * 1024 * 1024;

export async function GET(req: NextRequest) {
  const u = req.nextUrl.searchParams.get("u") ?? "";
  if (!ALLOWED.test(u)) return new Response("bad source", { status: 400 });
  try {
    const r = await fetch(u, { redirect: "follow", cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!r.ok) return new Response(`upstream ${r.status}`, { status: 502, headers: { "Cache-Control": "no-store" } });
    const ct = r.headers.get("content-type") ?? "";
    if (!/^image\//i.test(ct)) return new Response("not an image", { status: 502, headers: { "Cache-Control": "no-store" } });
    const body = await r.arrayBuffer();
    if (body.byteLength > MAX_BYTES) return new Response("too large", { status: 502, headers: { "Cache-Control": "no-store" } });
    return new Response(body, {
      headers: {
        "Content-Type": ct,
        "Cache-Control": "public, max-age=31536000, s-maxage=31536000, immutable",
      },
    });
  } catch {
    return new Response("fetch failed", { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
