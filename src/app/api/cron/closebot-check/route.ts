import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { queueCloseBotCheck } from "@/lib/closebot-coverage";

export const maxDuration = 60;

// Daily (weekly until 11/11/2026): the AI Agent reads CloseBot → Sources;
// the Alerts tab lists Live V3 clients without a CloseBot agent and non-V3
// accounts that still have one (owner 10/24/2026: "make sure everything is
// synced"), and each client's profile shows its CloseBot box. Read-only.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const r = await queueCloseBotCheck(createServiceClient(), "daily CloseBot check");
    return NextResponse.json({ timestamp: new Date().toISOString(), ...r });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
