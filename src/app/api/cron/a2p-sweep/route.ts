import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { queueA2pSweep } from "@/lib/pool-a2p";

export const maxDuration = 60;

// Weekly (Monday): queue an AI Agent A2P check for every clean-account pool
// account the agent hasn't verified in the last 6 days (owner 10/20/2026:
// "make sure there are no mistakes and the data is updated"). Read-only.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await queueA2pSweep(createServiceClient(), "weekly A2P sweep", 6);
  return NextResponse.json({ timestamp: new Date().toISOString(), ...result });
}
