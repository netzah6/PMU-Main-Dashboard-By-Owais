import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { runAiBackOn } from "@/lib/ai-back-on";

export const fetchCache = "force-no-store";
// Each check-in is followed by ~1.5 min of keeping the AI on through CloseBot's shutoff.
export const maxDuration = 300;

/* Hourly: AI back on after the artist's hand text (src/lib/ai-back-on.ts).
   Ships OFF (app_settings "ai_back_on"). ?dry=1 shows who WOULD get the
   check-in now and writes nothing — for the cron secret or an admin;
   &skips=1 also lists every skipped lead with the reason. */
export async function GET(req: NextRequest) {
  const dryRun = req.nextUrl.searchParams.get("dry") === "1";
  const listSkips = req.nextUrl.searchParams.get("skips") === "1";
  const authHeader = req.headers.get("authorization");
  // Texts go to real people, so a real send needs the cron secret — set AND matching.
  const cronOk = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;
  if (!cronOk) {
    const auth = dryRun ? await getAuth().catch(() => null) : null;
    if (auth?.role !== "admin") {
      return NextResponse.json({ error: process.env.CRON_SECRET ? "Unauthorized" : "CRON_SECRET is not set — this cron refuses to send without it" }, { status: 401 });
    }
  }
  try {
    const result = await runAiBackOn(createServiceClient(), { dryRun, listSkips });
    return NextResponse.json({ timestamp: new Date().toISOString(), ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
