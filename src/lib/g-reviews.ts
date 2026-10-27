import type { SupabaseClient } from "@supabase/supabase-js";

/* In-house Google reviews (owner, 10/27/2026): replaces the Elfsight
   reviews widget. Nothing is asked of the client — from the Google Business
   link already on file (or the business name + address) we find the place
   on Google Places, keep its rating, review count and best reviews, and the
   funnel renders them itself. A failed fetch leaves the previous set in
   place. Needs GOOGLE_PLACES_API_KEY (Places API (New)). */

const MAX_REVIEWS = 6;
const MIN_STARS = 4; // what a booking page should show
const REFRESH_DAYS = 13;

export type GReview = { name: string; pic: string; stars: number; text: string; when: string; at: string };
export type GReviews = { placeId: string; name: string; rating: number | null; count: number | null; reviews: GReview[]; at: string };
export type GFetchMark = { at: string; ok: boolean; why?: string };

export function placesReady(): boolean {
  return !!process.env.GOOGLE_PLACES_API_KEY;
}

/* "https://search.google.com/local/writereview?placeid=ChIJ…" → "ChIJ…";
   Maps links with !1s<id> or ?placeid= too. Anything else → "". */
export function placeIdFromLink(link: string | null | undefined): string {
  const s = String(link ?? "").trim();
  const m = s.match(/[?&]placeid=([A-Za-z0-9_-]{10,})/i) || s.match(/!1s(ChIJ[A-Za-z0-9_-]+)/) || s.match(/\/place\/[^/]+\/.*?\/(ChIJ[A-Za-z0-9_-]+)/);
  return m ? m[1] : "";
}

async function places<T>(path: string, init: RequestInit, fieldMask: string): Promise<T> {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error("no GOOGLE_PLACES_API_KEY");
  const r = await fetch(`https://places.googleapis.com/v1/${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": fieldMask, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`places ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as T;
}

type PlaceHit = { id?: string; displayName?: { text?: string }; formattedAddress?: string; userRatingCount?: number };

/* Resolve the place: a share link is followed to its real URL first; then
   the place id in the link; then a text search by name + address. */
export async function resolvePlaceId(link: string, name: string, address: string): Promise<{ id: string; via: string } | null> {
  let l = String(link ?? "").trim();
  if (/share\.google\/|maps\.app\.goo\.gl\/|g\.page\//i.test(l)) {
    try {
      const r = await fetch(l, { redirect: "follow", signal: AbortSignal.timeout(10_000), headers: { "user-agent": "Mozilla/5.0" } });
      l = r.url || l;
    } catch { /* keep the short link; the text search below still works */ }
  }
  const fromLink = placeIdFromLink(l);
  if (fromLink) return { id: fromLink, via: "link" };
  const q = [name, address].filter(Boolean).join(", ").trim();
  if (q.length < 6) return null;
  const res = await places<{ places?: PlaceHit[] }>("places:searchText", { method: "POST", body: JSON.stringify({ textQuery: q, maxResultCount: 3 }) }, "places.id,places.displayName,places.formattedAddress,places.userRatingCount");
  const hit = (res.places ?? []).find((p) => p.id);
  return hit?.id ? { id: hit.id, via: "search" } : null;
}

type PlaceDetails = {
  id?: string; displayName?: { text?: string }; rating?: number; userRatingCount?: number;
  reviews?: Array<{ rating?: number; text?: { text?: string }; originalText?: { text?: string }; relativePublishTimeDescription?: string; publishTime?: string; authorAttribution?: { displayName?: string; photoUri?: string } }>;
};

export async function fetchPlaceReviews(placeId: string): Promise<GReviews> {
  const d = await places<PlaceDetails>(`places/${encodeURIComponent(placeId)}`, { method: "GET" }, "id,displayName,rating,userRatingCount,reviews");
  const reviews: GReview[] = (d.reviews ?? [])
    .map((r) => ({
      name: (r.authorAttribution?.displayName ?? "").trim() || "Google user",
      pic: r.authorAttribution?.photoUri ?? "",
      stars: Math.max(1, Math.min(5, Math.round(Number(r.rating) || 0))),
      text: (r.text?.text ?? r.originalText?.text ?? "").trim(),
      when: r.relativePublishTimeDescription ?? "",
      at: r.publishTime ?? "",
    }))
    .filter((r) => r.stars >= MIN_STARS && r.text.length >= 20)
    .sort((a, b) => b.stars - a.stars || b.at.localeCompare(a.at))
    .slice(0, MAX_REVIEWS);
  return { placeId, name: d.displayName?.text ?? "", rating: typeof d.rating === "number" ? d.rating : null, count: typeof d.userRatingCount === "number" ? d.userRatingCount : null, reviews, at: new Date().toISOString().slice(0, 10) };
}

async function patchExtras(svc: SupabaseClient, slug: string, patch: Record<string, unknown>): Promise<string | null> {
  const { data: row } = await svc.from("onebox_clients").select("extras").eq("slug", slug).maybeSingle();
  const { error } = await svc.from("onebox_clients").update({ extras: { ...((row?.extras ?? {}) as Record<string, unknown>), ...patch } }).eq("slug", slug);
  return error ? error.message : null;
}

/* Fetch one funnel's reviews now; marks the attempt either way. */
export async function refreshReviews(svc: SupabaseClient, slug: string): Promise<{ ok: true; reviews: number; rating: number | null } | { ok: false; why: string }> {
  const { data: row } = await svc.from("onebox_clients").select("config, extras").eq("slug", slug).maybeSingle();
  const cfg = (row?.config ?? {}) as Record<string, string>;
  const prev = ((row?.extras ?? {}) as { gReviews?: GReviews }).gReviews;
  const mark = async (ok: boolean, why?: string) => patchExtras(svc, slug, { gFetch: { at: new Date().toISOString(), ok, ...(why ? { why } : {}) } as GFetchMark });
  try {
    const found = prev?.placeId ? { id: prev.placeId, via: "stored" } : await resolvePlaceId(cfg.gmbLink ?? "", cfg.businessName ?? cfg.name ?? "", cfg.address ?? "");
    if (!found) { await mark(false, "place not found (no Google link, and the name + address didn't match)"); return { ok: false, why: "place not found" }; }
    const g = await fetchPlaceReviews(found.id);
    if (!g.reviews.length) { await mark(false, `no ${MIN_STARS}+ star reviews with text on Google`); return { ok: false, why: "no usable reviews" }; }
    const err = await patchExtras(svc, slug, { gReviews: g, gFetch: { at: new Date().toISOString(), ok: true } });
    if (err) return { ok: false, why: err };
    return { ok: true, reviews: g.reviews.length, rating: g.rating };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    await mark(false, why);
    return { ok: false, why };
  }
}

/* Live funnels whose reviews were last tried more than REFRESH_DAYS ago
   (never tried first), with something to look the place up by. */
export async function dueForReviews(svc: SupabaseClient, limit: number, minAgeDays = REFRESH_DAYS): Promise<string[]> {
  const { data: clients } = await svc.from("onebox_clients").select("slug, config, extras").eq("status", "live");
  const cutoff = new Date(Date.now() - minAgeDays * 86400_000).toISOString();
  return (clients ?? [])
    .map((c) => {
      const cfg = (c.config ?? {}) as Record<string, string>;
      const ex = (c.extras ?? {}) as { template?: string; gWidgetOff?: boolean; gFetch?: GFetchMark };
      const lookup = !!(cfg.gmbLink?.trim() || (cfg.address?.trim() && (cfg.businessName || cfg.name)));
      return { slug: String(c.slug), ok: lookup && ex.template !== "b2b" && !ex.gWidgetOff, last: ex.gFetch?.at ?? "" };
    })
    .filter((c) => c.ok && c.last < cutoff)
    .sort((a, b) => a.last.localeCompare(b.last))
    .slice(0, limit)
    .map((c) => c.slug);
}
