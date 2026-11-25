import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { scanSmsLimit } from "@/lib/sms-limit";

export const maxDuration = 300;

// Every 30 min (offset from the alerts sweep, which is already near its 5
// minutes): which client accounts have hit GHL's daily text limit → 🚨 Alerts
// tab + the assigned coach's pop-up. See src/lib/sms-limit.ts.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const t0 = Date.now();
  const out = await scanSmsLimit(createServiceClient()).catch((e) => ({ error: String(e) }));
  return NextResponse.json({ timestamp: new Date().toISOString(), ms: Date.now() - t0, ...out });
}
