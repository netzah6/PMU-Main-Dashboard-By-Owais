import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { computeCallKillStats } from "@/lib/call-kill";

export const fetchCache = "force-no-store";
export const maxDuration = 300;

// Daily refresh of call_kill_stats — the CPD tab's "Kill %" column: how often
// each sub-account's AI dies after an artist's outgoing call. See
// src/lib/call-kill.ts for the definition and the root-cause story.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const svc = createServiceClient();
  const result = await computeCallKillStats(svc);
  return NextResponse.json({ timestamp: new Date().toISOString(), ...result });
}
