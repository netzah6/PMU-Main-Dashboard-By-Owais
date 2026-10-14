import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { syncSalesFollowUps } from "@/lib/sales-followups";

export const fetchCache = "force-no-store";
export const maxDuration = 300;

/* Hourly: re-read the GHL call/text log for every lead on the Sales
   to-do lists and recount their follow-ups (see lib/sales-followups). */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const res = await syncSalesFollowUps(createServiceClient(), { maxAgeMin: 45, deadlineMs: 270_000 });
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
