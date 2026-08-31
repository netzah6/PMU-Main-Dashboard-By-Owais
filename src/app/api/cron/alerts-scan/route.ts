import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { scanComplianceSynced, scanComplianceDeep, scanMakeScenarios, scanOnboardingPipeline } from "@/lib/alerts";

export const maxDuration = 300;

// Alerts sweep, every 30 min: compliance footers on lead texts (synced table
// scan + rotating deep thread scan) and Make.com scenario health. Upset-client
// alerts come from the agent-scan cron, not here.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const svc = createServiceClient();
  const [synced, deep, make, onboarding] = [
    await scanComplianceSynced(svc).catch((e) => ({ error: String(e) })),
    await scanComplianceDeep(svc).catch((e) => ({ error: String(e) })),
    await scanMakeScenarios(svc).catch((e) => ({ error: String(e) })),
    await scanOnboardingPipeline(svc).catch((e) => ({ error: String(e) })),
  ];
  return NextResponse.json({ timestamp: new Date().toISOString(), synced, deep, make, onboarding });
}
