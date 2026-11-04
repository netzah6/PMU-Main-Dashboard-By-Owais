import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { runFunnelTimeline } from "@/lib/funnel-timeline";

export const fetchCache = "force-no-store";
export const maxDuration = 300;

// Every 6 hours: save each funnel's page and settings if anything changed. See
// src/lib/funnel-timeline.ts. ?dry=1 computes only and writes nothing.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const p = req.nextUrl.searchParams;
  const result = await runFunnelTimeline(createServiceClient(), { origin: req.nextUrl.origin, dry: p.get("dry") === "1", slug: p.get("slug")?.trim() || undefined });
  return NextResponse.json({ timestamp: new Date().toISOString(), ...result });
}
