import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { dueFunnels, fetchPosts, fetchProfiles, markFetch, snapshotFunnel } from "@/lib/ig-fetch";

export const maxDuration = 300;
/* Stop starting new funnels after this; Vercel kills the function at 300 s
   and a funnel cut off mid-copy would be paid for on Apify for nothing. */
const TIME_BUDGET_MS = 250_000;

/* Daily: refresh the in-house Instagram feed for up to 20 funnels whose
   last fetch is older than 6 days (so the fleet turns over about weekly).
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
  const limit = Math.min(40, Number(req.nextUrl.searchParams.get("limit") ?? 20) || 20);
  const only = req.nextUrl.searchParams.get("slug");
  const due = only
    ? (await dueFunnels(svc, 500, -1)).filter((f) => f.slug === only)
    : await dueFunnels(svc, limit);
  if (!due.length) return NextResponse.json({ fetched: 0, note: "nothing due" });
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
  /* ?debug=1: show what the scraper returned (shape only), write nothing. */
  if (req.nextUrl.searchParams.get("debug")) {
    const shape = (v: unknown): unknown => typeof v === "string" ? v.slice(0, 140) : Array.isArray(v) ? `[${v.length}]` : v && typeof v === "object" ? Object.keys(v as object).slice(0, 40) : v;
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
      if (r.ok) { results[f.slug] = `ok (${r.imgs} images)`; continue; }
      why = r.why;
    }
    results[f.slug] = why;
    await markFetch(svc, f.slug, false, why);
  }
  return NextResponse.json({
    fetched: due.length - skipped.length,
    ok: Object.values(results).filter((v) => v.startsWith("ok")).length,
    skipped: skipped.length ? skipped : undefined,
    seconds: Math.round((Date.now() - t0) / 1000),
    profileErr: profileErr || undefined,
    results,
  });
}
