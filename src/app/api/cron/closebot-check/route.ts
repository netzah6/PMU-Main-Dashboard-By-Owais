import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { queueCloseBotCheck } from "@/lib/closebot-coverage";

export const maxDuration = 60;

// Weekly (Monday): the AI Agent reads CloseBot → Sources and the Alerts tab
// lists V3 clients without a CloseBot agent and non-V3 accounts that still
// have one (owner 10/24/2026: "make sure everything is synced"). Read-only.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const r = await queueCloseBotCheck(createServiceClient(), "weekly CloseBot check");
    return NextResponse.json({ timestamp: new Date().toISOString(), ...r });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
