import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { dueFunnels, fetchProfiles, snapshotFunnel } from "@/lib/ig-fetch";

export const maxDuration = 300;

/* Daily: refresh the in-house Instagram feed for up to 20 funnels whose
   set is older than 6 days (so the fleet turns over about weekly). Needs
   APIFY_TOKEN; without it the funnels keep serving their last set. */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.APIFY_TOKEN) return NextResponse.json({ skipped: "no APIFY_TOKEN — add it in Vercel (Settings → Environment Variables)" });
  const svc = createServiceClient();
  const limit = Math.min(40, Number(req.nextUrl.searchParams.get("limit") ?? 20) || 20);
  const only = req.nextUrl.searchParams.get("slug");
  const due = only
    ? (await dueFunnels(svc, 500, -1)).filter((f) => f.slug === only)
    : await dueFunnels(svc, limit);
  if (!due.length) return NextResponse.json({ fetched: 0, note: "nothing due" });
  const results: Record<string, string> = {};
  try {
    const profiles = await fetchProfiles(due.map((f) => f.username));
    for (const f of due) {
      const p = profiles.get(f.username.toLowerCase());
      if (!p) { results[f.slug] = "not returned (private, renamed, or blocked)"; continue; }
      if (p.error) { results[f.slug] = `scraper: ${p.errorDescription ?? p.error}`; continue; }
      const r = await snapshotFunnel(svc, f.slug, p, f.igLink);
      results[f.slug] = r.ok ? `ok (${r.imgs} images)` : r.why;
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e), results }, { status: 502 });
  }
  return NextResponse.json({ fetched: due.length, results });
}
