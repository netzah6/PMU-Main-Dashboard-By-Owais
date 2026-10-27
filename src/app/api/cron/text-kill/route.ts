import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { computeTextKillStats } from "@/lib/text-kill";

export const fetchCache = "force-no-store";
export const maxDuration = 300;

// Daily refresh of text_kill_stats — the CPD tab's "Kill Text" column: how
// often each sub-account's AI dies after the artist texts a lead herself.
// See src/lib/text-kill.ts. A run that hits the time budget only warms the
// verdict cache; call it again and it completes.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const svc = createServiceClient();
  const result = await computeTextKillStats(svc);
  return NextResponse.json({ timestamp: new Date().toISOString(), ...result });
}
