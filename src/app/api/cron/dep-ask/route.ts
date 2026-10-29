import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { checkDepAskReplies } from "@/lib/dep-ask";

export const fetchCache = "force-no-store";
export const maxDuration = 300;

// Hourly: which deposit-ask test leads texted the AI back before paying
// (the Funnels-tab "Deposit ask (AI)" card). See src/lib/dep-ask.ts. A run
// that hits the time budget picks up where it left off next hour.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const svc = createServiceClient();
  const result = await checkDepAskReplies(svc);
  return NextResponse.json({ timestamp: new Date().toISOString(), ...result });
}
