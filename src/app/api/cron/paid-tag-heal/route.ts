import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { healPaidTags, resolvePaidAlerts } from "@/lib/paid-tag-heal";

export const maxDuration = 120;

// Every 10 min: paid deposits whose GHL contact never got the paid tag.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const svc = createServiceClient();
  const result = await healPaidTags(svc, req.nextUrl.origin);
  const resolved = await resolvePaidAlerts(svc).catch(() => 0);
  return NextResponse.json({ timestamp: new Date().toISOString(), ...result, resolved });
}
