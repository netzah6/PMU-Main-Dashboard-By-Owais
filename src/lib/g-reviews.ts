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
export type GReviews = { placeId: string; fromLink?: string; name: string; rating: number | null; count: number | null; reviews: GReview[]; at: string };
export type GFetchMark = { at: string; ok: boolean; why?: string };

export function placesReady(): boolean {
  return !!process.env.GOOGLE_PLACES_API_KEY;
}

/* A Google Business link is only a link when it is one: "true" / "false" /
   notes typed into the field count as empty. */
export function cleanLink(link: string | null | undefined): string {
  const s = String(link ?? "").trim();
  return /^https?:\/\/\S+$/i.test(s) || /^[a-z0-9.-]+\.[a-z]{2,}\/\S*$/i.test(s) ? s : "";
}

/* "https://search.google.com/local/writereview?placeid=ChIJ…" → "ChIJ…";
   Maps links with !1s<id>, ?placeid=, q=place_id: too (a space after the
   "=" is tolerated — one client typed it). Anything else → "". */
export function placeIdFromLink(link: string | null | undefined): string {
  const s = String(link ?? "").trim();
  const m = s.match(/[?&]placeid=\s*([A-Za-z0-9_-]{10,})/i) || s.match(/place_id:([A-Za-z0-9_-]{10,})/i) || s.match(/!1s(ChIJ[A-Za-z0-9_-]+)/) || s.match(/\/place\/[^/]+\/.*?\/(ChIJ[A-Za-z0-9_-]+)/);
  return m ? m[1] : "";
}

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !/^(the|and|llc|inc|spa|studio|beauty|brows|brow|pmu|permanent|makeup|salon|by)$/.test(w));
/* The search hit must be the client's business: share a real word with
   the name, or sit at the same street number + zip. */
export function hitMatches(hit: PlaceHit, name: string, address: string): boolean {
  const hn = norm(hit.displayName?.text ?? ""); const bn = norm(name);
  if (bn.length && hn.some((w) => bn.includes(w))) return true;
  const num = (address.match(/^\s*(\d{1,6})\b/) || [])[1]; const zip = (address.match(/\b(\d{5})(?:-\d{4})?\s*$/) || [])[1];
  const fa = hit.formattedAddress ?? "";
  return !!(num && zip && fa.includes(num) && fa.includes(zip));
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

type PlaceHit = { id?: string; displayName?: { text?: string }; formattedAddress?: string };

/* Resolve the place: a share link is followed to its real URL first; then
   the place id in the link; then a text search by name + address whose
   hit must match the business (never an address-only guess). */
export async function resolvePlaceId(link: string, name: string, address: string): Promise<{ id: string; via: string } | null> {
  let l = cleanLink(link);
  if (/share\.google\/|maps\.app\.goo\.gl\/|g\.page\//i.test(l)) {
    try {
      const r = await fetch(l, { redirect: "follow", signal: AbortSignal.timeout(10_000), headers: { "user-agent": "Mozilla/5.0" } });
      l = r.url || l;
    } catch { /* keep the short link; the text search below still works */ }
  }
  const fromLink = placeIdFromLink(l);
  if (fromLink) return { id: fromLink, via: "link" };
  if (!name.trim()) return null;
  const q = [name, address].filter(Boolean).join(", ").trim();
  const res = await places<{ places?: PlaceHit[] }>("places:searchText", { method: "POST", body: JSON.stringify({ textQuery: q, maxResultCount: 5 }) }, "places.id,places.displayName,places.formattedAddress");
  const hit = (res.places ?? []).find((p) => p.id && hitMatches(p, name, address));
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

/* A Google error that will clear on its own (key not propagated yet, quota,
   timeout) must not park the funnel for two weeks. */
export const isTransient = (why: string) => /places (401|403|429|5\d\d)|aborted|timeout|fetch failed/i.test(why);

/* Fetch one funnel's reviews now; marks the attempt either way. The stored
   place id is reused only while the Google link it came from is unchanged;
   a link the owner corrected, or a 400/404 from Google, re-resolves. */
export async function refreshReviews(svc: SupabaseClient, slug: string): Promise<{ ok: true; reviews: number; rating: number | null } | { ok: false; why: string; transient?: boolean }> {
  const { data: row } = await svc.from("onebox_clients").select("config, extras").eq("slug", slug).maybeSingle();
  const cfg = (row?.config ?? {}) as Record<string, string>;
  const ex = (row?.extras ?? {}) as { gReviews?: GReviews; gLinkFromForm?: string };
  const prev = ex.gReviews;
  const link = cleanLink(cfg.gmbLink) || cleanLink(ex.gLinkFromForm);
  const name = String(cfg.biz ?? cfg.businessName ?? cfg.name ?? "").trim();
  const mark = async (ok: boolean, why?: string) => patchExtras(svc, slug, { gFetch: { at: new Date().toISOString(), ok, ...(why ? { why } : {}) } as GFetchMark });
  try {
    const reuse = prev?.placeId && (prev.fromLink ?? "") === link;
    const found = reuse ? { id: prev!.placeId, via: "stored" } : await resolvePlaceId(link, name, cfg.address ?? "");
    if (!found) { await mark(false, "place not found (no Google link, and no search hit matched the name or address)"); return { ok: false, why: "place not found" }; }
    let g: GReviews;
    try {
      g = await fetchPlaceReviews(found.id);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      if (reuse && /places (400|404)/.test(why)) {
        /* Google retired the stored id: forget it (keep the reviews showing)
           and resolve afresh next time. */
        await patchExtras(svc, slug, { gReviews: { ...prev!, placeId: "" }, gFetch: { at: new Date().toISOString(), ok: false, why } });
        return { ok: false, why: `${why} — stored place id dropped, re-resolving next run` };
      }
      throw e;
    }
    g.fromLink = link;
    if (!g.reviews.length) { await mark(false, `no ${MIN_STARS}+ star reviews with text on Google`); return { ok: false, why: "no usable reviews" }; }
    const err = await patchExtras(svc, slug, { gReviews: g, gFetch: { at: new Date().toISOString(), ok: true } });
    if (err) return { ok: false, why: err };
    return { ok: true, reviews: g.reviews.length, rating: g.rating };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    await mark(false, why);
    return { ok: false, why, transient: isTransient(why) };
  }
}

/* Forget everything Google for one funnel (dashboard / cron ?reset=1). */
export async function resetReviews(svc: SupabaseClient, slug: string) {
  const { data: row } = await svc.from("onebox_clients").select("extras").eq("slug", slug).maybeSingle();
  const extras = { ...((row?.extras ?? {}) as Record<string, unknown>) };
  delete extras.gReviews; delete extras.gFetch;
  await svc.from("onebox_clients").update({ extras }).eq("slug", slug);
}

/* Live funnels whose reviews were last tried more than REFRESH_DAYS ago
   (never tried first), with something to look the place up by. */
export async function dueForReviews(svc: SupabaseClient, limit: number, minAgeDays = REFRESH_DAYS): Promise<string[]> {
  const { data: clients } = await svc.from("onebox_clients").select("slug, config, extras").eq("status", "live");
  const cutoff = new Date(Date.now() - minAgeDays * 86400_000).toISOString();
  /* A failed attempt is retried after a day, not two weeks. */
  const retryCutoff = new Date(Date.now() - Math.min(minAgeDays, 1) * 86400_000).toISOString();
  return (clients ?? [])
    .map((c) => {
      const cfg = (c.config ?? {}) as Record<string, string>;
      const ex = (c.extras ?? {}) as { template?: string; gWidgetOff?: boolean; gFetch?: GFetchMark; gLinkFromForm?: string };
      const name = String(cfg.biz ?? cfg.businessName ?? cfg.name ?? "").trim();
      const lookup = !!(cleanLink(cfg.gmbLink) || cleanLink(ex.gLinkFromForm) || (cfg.address?.trim() && name));
      return { slug: String(c.slug), ok: lookup && ex.template !== "b2b" && !ex.gWidgetOff, last: ex.gFetch?.at ?? "", failed: ex.gFetch?.ok === false };
    })
    .filter((c) => c.ok && c.last < (c.failed ? retryCutoff : cutoff))
    .sort((a, b) => a.last.localeCompare(b.last))
    .slice(0, limit)
    .map((c) => c.slug);
}

/* ?debug=1&slug=: what Google says for one funnel — the search hits and
   the raw review shapes — so a "not found" or "no usable reviews" can be
   explained without the key leaving Vercel. Writes nothing. */
export async function debugReviews(svc: SupabaseClient, slug: string): Promise<Record<string, unknown>> {
  const { data: row } = await svc.from("onebox_clients").select("config, extras").eq("slug", slug).maybeSingle();
  const cfg = (row?.config ?? {}) as Record<string, string>;
  const ex = (row?.extras ?? {}) as { gReviews?: GReviews; gLinkFromForm?: string };
  const link = cleanLink(cfg.gmbLink) || cleanLink(ex.gLinkFromForm);
  const name = String(cfg.biz ?? "").trim();
  const out: Record<string, unknown> = { link, name, address: cfg.address ?? "", fromLinkId: placeIdFromLink(link) };
  try {
    if (name) {
      const q = [name, cfg.address].filter(Boolean).join(", ");
      const res = await places<{ places?: PlaceHit[] }>("places:searchText", { method: "POST", body: JSON.stringify({ textQuery: q, pageSize: 5 }) }, "places.id,places.displayName,places.formattedAddress");
      out.search = (res.places ?? []).map((p) => ({ id: p.id, name: p.displayName?.text, address: p.formattedAddress, matches: hitMatches(p, name, cfg.address ?? "") }));
    }
    const found = await resolvePlaceId(link, name, cfg.address ?? "");
    out.resolved = found;
    if (found) {
      const d = await places<PlaceDetails>(`places/${encodeURIComponent(found.id)}`, { method: "GET" }, "id,displayName,rating,userRatingCount,reviews");
      out.details = { name: d.displayName?.text, rating: d.rating, count: d.userRatingCount, reviews: (d.reviews ?? []).map((r) => ({ stars: r.rating, textLen: (r.text?.text ?? "").length, origLen: (r.originalText?.text ?? "").length, keys: Object.keys(r) })) };
    }
  } catch (e) { out.error = e instanceof Error ? e.message : String(e); }
  return out;
}
