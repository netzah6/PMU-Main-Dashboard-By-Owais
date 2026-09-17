import { NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";
import { signLogoUrl } from "@/lib/logo-sign";

// Immutable caching proxy for client logos. GHL's image service costs
// ~0.3-1.2s per request and is the slowest visible element on the funnel;
// behind this route the first visitor per edge region pays that once and
// everyone after is served from the CDN in ~30ms. The source URL is part
// of the cache key, so a changed logo is a new entry — immutable is safe.
//
// Security posture (review findings 2026-09-17): the `u` param must carry
// the HMAC signature /f minted for it — attacker-chosen sources never
// reach the cache (kills the GCS path-traversal, redirect-hop, and
// amplification classes in one move). The host allowlist stays as
// defense-in-depth, parsed with new URL (exact hostname + normalized
// path), never a prefix regex. Content-type is a strict raster allowlist:
// image/svg+xml would be same-origin scriptable, cached for a year, on
// every host this deployment serves. Size is checked via Content-Length
// BEFORE buffering and re-checked after.
export const maxDuration = 30;

const HOSTS = new Set(["images.leadconnectorhq.com", "assets.cdn.filesafe.space", "services.leadconnectorhq.com", "storage.googleapis.com"]);
const RASTER = /^image\/(png|jpe?g|webp|gif|avif)(;|$)/i;
const MAX_BYTES = 3 * 1024 * 1024;

function allowed(u: string): boolean {
  let url: URL;
  try { url = new URL(u); } catch { return false; }
  if (url.protocol !== "https:" || !HOSTS.has(url.hostname)) return false;
  if (url.hostname === "storage.googleapis.com" && !url.pathname.startsWith("/msgsndr/")) return false;
  return true;
}

export async function GET(req: NextRequest) {
  const u = req.nextUrl.searchParams.get("u") ?? "";
  const s = req.nextUrl.searchParams.get("s") ?? "";
  const expected = signLogoUrl(u);
  if (!expected || s.length !== expected.length ||
      !timingSafeEqual(Buffer.from(s), Buffer.from(expected))) {
    return new Response("bad signature", { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  if (!allowed(u)) return new Response("bad source", { status: 400, headers: { "Cache-Control": "no-store" } });
  try {
    const r = await fetch(u, { redirect: "follow", cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!r.ok) return new Response(`upstream ${r.status}`, { status: 502, headers: { "Cache-Control": "no-store" } });
    const ct = r.headers.get("content-type") ?? "";
    if (!RASTER.test(ct)) return new Response("not a raster image", { status: 502, headers: { "Cache-Control": "no-store" } });
    const len = Number(r.headers.get("content-length") ?? "0");
    if (len > MAX_BYTES) return new Response("too large", { status: 502, headers: { "Cache-Control": "no-store" } });
    const body = await r.arrayBuffer();
    if (body.byteLength > MAX_BYTES) return new Response("too large", { status: 502, headers: { "Cache-Control": "no-store" } });
    return new Response(body, {
      headers: {
        "Content-Type": ct,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "public, max-age=31536000, s-maxage=31536000, immutable",
      },
    });
  } catch {
    return new Response("fetch failed", { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
