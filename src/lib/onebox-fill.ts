import type { SupabaseClient } from "@supabase/supabase-js";
import { waitUntil } from "@vercel/functions";
import { SKIP_SLUGS, patchExtras, refreshFunnel, usernameFromLink, type IgFetchMark } from "@/lib/ig-fetch";
import { cleanLink, isTransient, placesReady, refreshReviews, reviewLookupKey, type GFetchMark, type GReviews } from "@/lib/g-reviews";
import { pingFunnel } from "@/lib/onebox-warm";

/* First fill (owner, 11/17/2026). A funnel added by hand in the Funnels tab
   had its Instagram and Google links saved but showed neither section: the
   hourly Instagram job and the daily reviews job only read LIVE funnels, the
   new-client setup run (the only thing that fetches at once) never ran for
   it, and "Go live" fetched nothing — so a draft stayed empty, and a funnel
   set live waited up to an hour for pictures and a day for reviews.

   Now the dashboard actions that put links on a funnel (Add client, Sync
   from GHL, saving the values, Go live) fetch right after they answer:
     Instagram — when the funnel has a handle that was never tried, or the
                 handle is not the one the last attempt asked for.
     Reviews   — when the place was never looked up, the Google link (or,
                 with no link, the name + address) changed since the last
                 attempt, or that attempt failed on a Google hiccup.
   A handle / place that was tried and failed is NOT tried again on every
   save: the scheduled jobs keep their own retry rules for those. Same
   switches as the jobs: B2B funnels, a section turned off, and (Instagram
   only) a frozen funnel are left alone. */

export type FillRow = { slug: string; config: Record<string, string> | null; extras: Record<string, unknown> | null; frozen_engine: number | null };
type Need = { ig: string; reviews: string }; // what to fetch: the handle / the lookup key ("" = nothing)

const CLAIM_MS = 4 * 60_000;
/* Budgets count from the start of the request (route maxDuration 300 s).
   A second pass needs room for a full Instagram run (Apify ≤ 140 s plus the
   picture copies); the cache ping waits 65 s first. */
const DEADLINE_MS = 290_000;
const SECOND_PASS_ROOM_MS = 190_000;
const PING_ROOM_MS = 70_000;

type Claim = { at?: string; ig?: string; reviews?: string };
const claimOf = (row: FillRow): Claim | undefined => ((row.extras ?? {}) as { mediaFill?: Claim }).mediaFill;
const isFresh = (c: Claim | undefined): c is Claim => !!c?.at && Date.now() - Date.parse(c.at) < CLAIM_MS;

/* `need` minus what a running fill (a fresh claim) already fetches. */
function unclaimed(need: Need, c: Claim | undefined): Need {
  if (!isFresh(c)) return need;
  return { ig: need.ig && c.ig === need.ig ? "" : need.ig, reviews: need.reviews && c.reviews === need.reviews ? "" : need.reviews };
}

/* Claim `run` on top of whatever a running fill still holds, so a save made
   meanwhile starts neither part again. Returns the claim's time. */
async function claim(svc: SupabaseClient, slug: string, run: Need, current: Claim | undefined): Promise<string | null> {
  const at = new Date().toISOString();
  const keep = isFresh(current) ? current : undefined;
  const err = await patchExtras(svc, slug, { mediaFill: { at, ig: run.ig || keep?.ig || "", reviews: run.reviews || keep?.reviews || "" } });
  return err ? null : at;
}

export function fillNeeds(row: FillRow): Need {
  const cfg = row.config ?? {};
  const ex = (row.extras ?? {}) as {
    template?: string; igWidgetOff?: boolean; gWidgetOff?: boolean; gLinkFromForm?: string;
    igFetch?: IgFetchMark; igFeed?: { profile?: { username?: string } }; gFetch?: GFetchMark; gReviews?: GReviews;
  };
  if (ex.template === "b2b") return { ig: "", reviews: "" };

  let ig = "";
  const user = usernameFromLink(cfg.igLink).toLowerCase();
  if (user && !ex.igWidgetOff && row.frozen_engine == null && !SKIP_SLUGS.has(row.slug)) {
    /* Which handle the last attempt asked for. Marks written before 11/17
       carry none: a stored feed still names its profile; a failed attempt
       with no feed is unknown, and unknown is not "changed". */
    const tried = ex.igFetch ? String(ex.igFetch.user ?? ex.igFeed?.profile?.username ?? "").toLowerCase() : null;
    if (tried === null || (tried !== "" && tried !== user)) ig = user;
  }

  let reviews = "";
  const key = reviewLookupKey(cfg, ex);
  if (key && !ex.gWidgetOff && placesReady()) {
    const m = ex.gFetch;
    const hiccup = !!m && m.ok === false && isTransient(m.why ?? "");
    let due: boolean;
    if (!m) due = true;
    else if (m.q != null) due = m.q !== key || hiccup;
    /* Older mark: only a changed Google link is certain (the stored set remembers its link). */
    else if (ex.gReviews) due = (ex.gReviews.fromLink ?? "") !== (cleanLink(cfg.gmbLink) || cleanLink(ex.gLinkFromForm)) || hiccup;
    else due = hiccup;
    if (due) reviews = key;
  }
  return { ig, reviews };
}

async function readRow(svc: SupabaseClient, slug: string): Promise<FillRow | null> {
  const { data } = await svc.from("onebox_clients").select("slug, config, extras, frozen_engine").eq("slug", slug).maybeSingle();
  return (data as FillRow | null) ?? null;
}

/* Fetch `first` — reviews first (a second or two), then the pictures (up to
   a couple of minutes). A second look afterwards catches a link corrected
   in GHL while the first fetch ran (a dashboard save starts its own fill),
   skipping what this fill just tried and what a newer fill already runs.
   Then one visit refreshes the page's edge copy. Returns what was stored. */
export async function fillFunnelMedia(svc: SupabaseClient, slug: string, first: Need, opts: { claimAt: string; startedAt?: number }): Promise<{ ig?: string; reviews?: string }> {
  const deadline = (opts.startedAt ?? Date.now()) + DEADLINE_MS;
  const out: { ig?: string; reviews?: string } = {};
  let stored = false;
  let need = first;
  let myAt = opts.claimAt;
  for (let pass = 0; pass < 2; pass++) {
    if (pass) {
      if (deadline - Date.now() < SECOND_PASS_ROOM_MS) break;
      const row = await readRow(svc, slug);
      if (!row) break;
      const now = fillNeeds(row);
      let next: Need = { ig: now.ig === need.ig ? "" : now.ig, reviews: now.reviews === need.reviews ? "" : now.reviews };
      const c = claimOf(row);
      if (c?.at !== myAt) next = unclaimed(next, c);
      if (!next.ig && !next.reviews) break;
      const at = await claim(svc, slug, next, c);
      if (!at) break;
      myAt = at;
      need = next;
    }
    if (need.reviews) {
      const r = await refreshReviews(svc, slug).catch((e) => ({ ok: false as const, why: e instanceof Error ? e.message : String(e) }));
      out.reviews = r.ok ? `${r.reviews} reviews` : r.why;
      stored = stored || r.ok;
    }
    if (need.ig) {
      const r = await refreshFunnel(svc, slug).catch((e) => ({ ok: false as const, why: e instanceof Error ? e.message : String(e) }));
      out.ig = r.ok ? `${r.imgs} pictures` : r.why;
      stored = stored || r.ok;
    }
  }
  /* Show it: after the page's fresh minute has passed, one visit makes the
     edge copy pick the new sections up (same idea as warmFunnel). */
  if (stored && deadline - Date.now() > PING_ROOM_MS) {
    await new Promise((r) => setTimeout(r, 65_000));
    await pingFunnel(slug);
  }
  return out;
}

/* Called at the end of a dashboard action, with the time the request
   started. Decides from the stored row, starts what is not already running
   in the background (the answer never waits for it) and returns a line for
   the toast — undefined when there is nothing to start. Never throws: a
   save must not fail over this. */
export async function startFunnelFill(svc: SupabaseClient, slug: string, startedAt?: number): Promise<string | undefined> {
  try {
    const row = await readRow(svc, slug);
    if (!row) return undefined;
    const current = claimOf(row);
    const run = unclaimed(fillNeeds(row), current);
    if (!run.ig && !run.reviews) return undefined;
    const claimAt = await claim(svc, slug, run, current);
    if (!claimAt) return undefined;
    waitUntil(fillFunnelMedia(svc, slug, run, { claimAt, startedAt }).then(() => undefined).catch((e) => { console.error("[onebox-fill]", slug, e instanceof Error ? e.message : e); }));
    return run.ig && run.reviews ? "Fetching the Instagram pictures and Google reviews now (about a minute)"
      : run.ig ? "Fetching the Instagram pictures now (about a minute)" : "Fetching the Google reviews now";
  } catch {
    return undefined;
  }
}
