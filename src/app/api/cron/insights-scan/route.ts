import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { runInsightScan } from "@/lib/onebox-insights";

export const maxDuration = 300;

// Daily optimizer sweep over the live B2C one-box funnels. Anything it finds
// lands as a PROPOSED insight on the Funnels tab — nothing changes without
// an explicit approve there.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const svc = createServiceClient();
  const result = await runInsightScan(svc, req.nextUrl.origin).catch((e) => ({ error: String(e) }));
  return NextResponse.json({ timestamp: new Date().toISOString(), ...result });
}
