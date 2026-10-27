import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { queueIgPostsSweep } from "@/lib/ig-posts-check";
import { classifyStoredFeed, dueFunnels, fetchDetails, fetchPosts, fetchProfiles, markFetch, snapshotFunnel, unclassifiedFunnels } from "@/lib/ig-fetch";

export const maxDuration = 300;
/* Stop starting new funnels after this; Vercel kills the function at 300 s
   and a funnel cut off mid-copy would be paid for on Apify for nothing. */
const TIME_BUDGET_MS = 250_000;

/* Hourly: refresh the in-house Instagram feed for up to 6 funnels whose
   last fetch is older than two weeks (the post scraper takes ~10 s per
   profile, so 20 at once timed out; 6 an hour turns the fleet over in a
   day and the 13-day rule spreads it across the fortnight).
   Needs APIFY_TOKEN; without it the funnels keep serving their last set.
   Every attempt is marked on the funnel (extras.igFetch), success or not,
   so a profile that keeps failing goes to the back of the line. */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.APIFY_TOKEN) return NextResponse.json({ skipped: "no APIFY_TOKEN — add it in Vercel (Settings → Environment Variables)" });
  const t0 = Date.now();
  const svc = createServiceClient();
  const limit = Math.min(12, Number(req.nextUrl.searchParams.get("limit") ?? 6) || 6);
  /* ?classify=1: look at the pictures the funnels already have (no Apify),
     up to `limit` funnels — the fleet backfill. */
  if (req.nextUrl.searchParams.get("classify")) {
    const slugs = await unclassifiedFunnels(svc, Math.min(40, Number(req.nextUrl.searchParams.get("limit") ?? 10) || 10));
    const done: Record<string, number> = {};
    const errors: string[] = [];
    for (const s of slugs) {
      if (Date.now() - t0 > TIME_BUDGET_MS) break;
      done[s] = await classifyStoredFeed(svc, s, errors);
    }
    const left = (await unclassifiedFunnels(svc, 500)).length;
    return NextResponse.json({ classified: done, left, errors: errors.length ? [...new Set(errors)].slice(0, 8) : undefined, seconds: Math.round((Date.now() - t0) / 1000) });
  }
  const only = req.nextUrl.searchParams.get("slug");
  const due = only
    ? (await dueFunnels(svc, 500, -1)).filter((f) => f.slug === only)
    : await dueFunnels(svc, limit);
  if (!due.length) {
    /* Nothing to fetch — use the hour to sort any grid that still has
       unsorted pictures. */
    const tail: Record<string, number> = {};
    for (const s of await unclassifiedFunnels(svc, 8)) { if (Date.now() - t0 > TIME_BUDGET_MS) break; tail[s] = await classifyStoredFeed(svc, s); }
    return NextResponse.json({ fetched: 0, note: "nothing due", classified: Object.keys(tail).length ? tail : undefined });
  }
  const results: Record<string, string> = {};
  const skipped: string[] = [];
  const names = due.map((f) => f.username);
  let profileErr = "";
  /* Posts and profile details run side by side. Posts are what the grid
     needs: if that run fails (Apify down, slow, token wrong, credit gone)
     nothing is marked, so the same funnels are first in line tomorrow.
     Profile details are nice-to-have — the previous set's stay if missing. */
  const [profiles, postsRes] = await Promise.all([
    fetchProfiles(names).catch((e) => { profileErr = e instanceof Error ? e.message : String(e); return new Map(); }),
    fetchPosts(names).then((m) => ({ ok: true as const, m })).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) })),
  ]);
  if (!postsRes.ok) return NextResponse.json({ error: postsRes.error, profileErr: profileErr || undefined, due: due.map((f) => f.slug) }, { status: 502 });
  const posts = postsRes.m;
  /* ?debug=1: show what the scraper returned (shape only), write nothing.
     ?debug=1&details=1 also probes the general scraper's details mode. */
  if (req.nextUrl.searchParams.get("debug")) {
    const shape = (v: unknown): unknown => typeof v === "string" ? v.slice(0, 140) : Array.isArray(v) ? `[${v.length}]` : v && typeof v === "object" ? Object.keys(v as object).slice(0, 40) : v;
    let details: unknown = undefined;
    if (req.nextUrl.searchParams.get("details")) {
      try {
        const d = await fetchDetails(names);
        details = names.map((n) => { const p = d.get(n.toLowerCase()) as Record<string, unknown> | undefined; return p ? Object.fromEntries(Object.entries(p).filter(([k]) => !/latestPosts|relatedProfiles|latestIgtv/.test(k)).map(([k, v]) => [k, shape(v)])) : "not returned"; });
      } catch (e) { details = `error: ${e instanceof Error ? e.message : String(e)}`; }
    }
    return NextResponse.json({
      due: due.map((f) => f.username),
      raw: due.map((f) => {
        const p = profiles.get(f.username.toLowerCase()) as Record<string, unknown> | undefined;
        const ps = (posts.get(f.username.toLowerCase()) ?? []) as Record<string, unknown>[];
        return {
          slug: f.slug, posts: ps.length, firstPost: ps[0] ? Object.fromEntries(Object.entries(ps[0]).map(([k, v]) => [k, shape(v)])) : null,
          profile: p ? { keys: Object.keys(p), error: p.error, errorDescription: p.errorDescription, followers: p.followersCount, private: p.private, pic: !!p.profilePicUrl } : "not returned",
        };
      }),
      profileErr: profileErr || undefined,
      details,
    });
  }
  for (const f of due) {
    if (Date.now() - t0 > TIME_BUDGET_MS) { skipped.push(f.slug); continue; }
    const p = profiles.get(f.username.toLowerCase());
    const ps = posts.get(f.username.toLowerCase()) ?? [];
    let why = "";
    if (!ps.length) why = p?.private ? "private account" : p?.error ? `scraper: ${p.errorDescription ?? p.error}` : "no posts returned (private, renamed, or blocked)";
    else {
      const r = await snapshotFunnel(svc, f.slug, p, ps, f.igLink);
      if (r.ok) { results[f.slug] = `ok (${r.imgs} images, ${r.results} results posts)`; continue; }
      why = r.why;
    }
    results[f.slug] = why;
    await markFetch(svc, f.slug, false, why);
  }
  // Funnels whose header still has no post count (any age): one Mac Mini
  // card each, read off the public profile page. Dedupes while queued.
  let postsCheck: { queued: number; reused: number } | undefined;
  try { postsCheck = await queueIgPostsSweep(svc, "ig-fetch cron", 10); } catch { /* next run */ }
  return NextResponse.json({
    postsCheck,
    fetched: due.length - skipped.length,
    ok: Object.values(results).filter((v) => v.startsWith("ok")).length,
    skipped: skipped.length ? skipped : undefined,
    seconds: Math.round((Date.now() - t0) / 1000),
    profileErr: profileErr || undefined,
    results,
  });
}
