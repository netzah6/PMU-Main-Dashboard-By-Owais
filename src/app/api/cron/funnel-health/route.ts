import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { runFunnelHealth } from "@/lib/funnel-health";

export const fetchCache = "force-no-store";
export const maxDuration = 300;

// Every 3 hours: is the Instagram grid / Google reviews really showing on
// every live funnel? See src/lib/funnel-health.ts. Files / updates / closes
// "funnel_widgets" alerts and logs the run for the Funnels-tab card.
// ?dry=1   compute only, write nothing
// ?slug=x  one funnel (no run log)
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const p = req.nextUrl.searchParams;
  const svc = createServiceClient();
  const result = await runFunnelHealth(svc, { dry: p.get("dry") === "1", slug: p.get("slug")?.trim() || undefined });
  return NextResponse.json({ timestamp: new Date().toISOString(), ...result });
}
