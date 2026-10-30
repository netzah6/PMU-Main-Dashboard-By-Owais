import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { cronTick, syncClients } from "@/lib/ig-engage";

export const maxDuration = 60;

// Hourly: adds new sign-ups' Instagram handles, and once a day (at that day's
// hour, never on the week's rest day) files the Mac Mini's Instagram run.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const svc = createServiceClient();
    const sync = await syncClients(svc);
    const run = await cronTick(svc);
    return NextResponse.json({ timestamp: new Date().toISOString(), sync, run });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
