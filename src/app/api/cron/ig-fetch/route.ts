import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { dueFunnels, fetchProfiles, markFetch, snapshotFunnel } from "@/lib/ig-fetch";

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
  let profiles;
  try {
    profiles = await fetchProfiles(due.map((f) => f.username));
  } catch (e) {
    /* The whole run failed (Apify down, slow, or the token is wrong): no
       marks, so the same funnels are first in line tomorrow. */
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e), due: due.map((f) => f.slug) }, { status: 502 });
  }
  for (const f of due) {
    if (Date.now() - t0 > TIME_BUDGET_MS) { skipped.push(f.slug); continue; }
    const p = profiles.get(f.username.toLowerCase());
    let why = "";
    if (!p) why = "not returned (private, renamed, or blocked)";
    else if (p.error) why = `scraper: ${p.errorDescription ?? p.error}`;
    else {
      const r = await snapshotFunnel(svc, f.slug, p, f.igLink);
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
    results,
  });
}
