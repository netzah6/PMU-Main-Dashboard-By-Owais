import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { runDiscoveryCallCheck } from "@/lib/discovery-call-check";

export const maxDuration = 60;

// Every minute: discovery appointments 8–20 min past their start with no call
// to the lead yet → Alerts tab + one text to the owner. ?dry=1 only reports.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const dry = req.nextUrl.searchParams.get("dry") === "1";
    const r = await runDiscoveryCallCheck(createServiceClient(), { dry });
    return NextResponse.json({ timestamp: new Date().toISOString(), dry, ...r });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
