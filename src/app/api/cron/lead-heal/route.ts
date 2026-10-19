import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { healLeadRows } from "@/lib/lead-heal";

export const fetchCache = "force-no-store";
export const maxDuration = 300;

/* Every 2 h: any recent GoHighLevel lead (survey / one-box source) with no
   leads_master row gets one (see lib/lead-heal). ?days=N widens the window,
   ?dry=1 only counts. */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const days = Math.min(90, Math.max(1, Number(req.nextUrl.searchParams.get("days")) || 30));
  const dryRun = req.nextUrl.searchParams.get("dry") === "1";
  try {
    const res = await healLeadRows(createServiceClient(), { days, dryRun, timeBudgetMs: 250_000 });
    return NextResponse.json({ ok: true, days, dryRun, ...res });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
