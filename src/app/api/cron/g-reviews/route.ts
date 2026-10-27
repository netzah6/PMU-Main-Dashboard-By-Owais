import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { dueForReviews, placesReady, refreshReviews } from "@/lib/g-reviews";

export const maxDuration = 300;
const TIME_BUDGET_MS = 250_000;

/* Daily: refresh the in-house Google reviews for the funnels whose last
   attempt is older than two weeks (never tried first). Needs
   GOOGLE_PLACES_API_KEY; without it the funnels keep their last set.
   ?slug= forces one funnel; ?limit= up to 60 a run. */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!placesReady()) return NextResponse.json({ skipped: "no GOOGLE_PLACES_API_KEY — add it in Vercel (Settings → Environment Variables)" });
  const t0 = Date.now();
  const svc = createServiceClient();
  const only = req.nextUrl.searchParams.get("slug");
  const limit = Math.min(60, Number(req.nextUrl.searchParams.get("limit") ?? 30) || 30);
  const slugs = only ? [only] : await dueForReviews(svc, limit);
  if (!slugs.length) return NextResponse.json({ fetched: 0, note: "nothing due" });
  const results: Record<string, string> = {};
  const skipped: string[] = [];
  for (const slug of slugs) {
    if (Date.now() - t0 > TIME_BUDGET_MS) { skipped.push(slug); continue; }
    const r = await refreshReviews(svc, slug);
    results[slug] = r.ok ? `ok (${r.reviews} reviews${r.rating != null ? `, ${r.rating}★` : ""})` : r.why;
  }
  return NextResponse.json({
    fetched: slugs.length - skipped.length,
    ok: Object.values(results).filter((v) => v.startsWith("ok")).length,
    skipped: skipped.length ? skipped : undefined,
    seconds: Math.round((Date.now() - t0) / 1000),
    results,
  });
}
