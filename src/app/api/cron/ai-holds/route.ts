import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { holdCleanupScope, removeAiHolds } from "@/lib/ai-hold-cleanup";

export const maxDuration = 300;

// Every 10 min: cancel the AI's unpaid "invalid" holds (see lib/ai-hold-cleanup).
// OFF unless app_settings "ai_hold_cleanup" (or env AI_HOLD_CLEANUP) names accounts.
// ?dry=1 lists what it would remove without touching anything.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const svc = createServiceClient();
  const scope = await holdCleanupScope(svc);
  if (!scope) return NextResponse.json({ off: true });
  const result = await removeAiHolds(svc, { scope, dryRun: req.nextUrl.searchParams.get("dry") === "1" });
  return NextResponse.json({ timestamp: new Date().toISOString(), scope, ...result });
}
