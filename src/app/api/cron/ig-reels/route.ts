import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { judgeFunnelReels, pendingReelFunnels } from "@/lib/ig-reels";

export const maxDuration = 300;
/* Stop starting new reels after this; a reel takes ~20 s (download, 10
   frames, one Claude look) and Vercel kills the function at 300 s. */
const TIME_BUDGET_MS = 230_000;

/* Hourly (:40): judge the reels the Instagram fetch copied (ig-fetch.ts) —
   best frame from inside the reel becomes its tile, reels that show no real
   work sink behind the pictures (ig-reels.ts). Funnels with the most
   waiting reels first. ?slug= one funnel; ?slug=&dry=1 re-judges that
   funnel's reels (judged or not, ≤12) and writes nothing. */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const t0 = Date.now();
  const deadline = t0 + TIME_BUDGET_MS;
  const svc = createServiceClient();
  const only = req.nextUrl.searchParams.get("slug");
  const dry = !!req.nextUrl.searchParams.get("dry") && !!only;
  const errors: string[] = [];
  const funnels = only ? [{ slug: only, n: 0 }] : await pendingReelFunnels(svc, 40);
  const done: Record<string, unknown> = {};
  for (const f of funnels) {
    if (Date.now() > deadline) break;
    const out = await judgeFunnelReels(svc, f.slug, deadline, { dry, errors });
    if (!out.length) continue;
    done[f.slug] = dry
      ? out
      : { judged: out.filter((o) => !o.error).length, useful: out.filter((o) => o.useful).length, failed: out.filter((o) => o.error).length };
  }
  const left = dry ? undefined : (await pendingReelFunnels(svc, 500)).reduce((a, f) => a + f.n, 0);
  return NextResponse.json({ done, reelsLeft: left, errors: errors.length ? [...new Set(errors)].slice(0, 10) : undefined, seconds: Math.round((Date.now() - t0) / 1000) });
}
