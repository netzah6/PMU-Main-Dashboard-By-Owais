import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { scanComplianceSynced, scanComplianceDeep, scanMakeScenarios, scanOnboardingPipeline, scanDuplicateLeads, scanIngestHealth, scanAgreementMissing, scanLeadsWhileNotLive, scanSilentLeads, scanDoubleBookings, scanLiveNoPayDate, scanOneboxNotifyMissing, scanPaidNets } from "@/lib/alerts";
import { autoMergeClientDuplicates } from "@/lib/client-dupes";
import { scanFirstCycleLogins } from "@/lib/first-cycle";
import { scanServiceHealth } from "@/lib/service-health";

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
  // How long each part takes (ms), so a slow part shows in one run (owner 11/22/2026: the sweep took 4.5 of its 5 minutes).
  const ms: Record<string, number> = {};
  const timed = async <T,>(name: string, fn: () => Promise<T>): Promise<T | { error: string }> => {
    const t0 = Date.now();
    try { return await fn(); } catch (e) { return { error: String(e) }; } finally { ms[name] = Date.now() - t0; }
  };
  // First, and on its own: are the paid-booking safety nets still running? (Must not wait behind the long scans.)
  const paidNets = await timed("scanPaidNets", () => scanPaidNets(svc));
  // Outside services (Apify, Claude, Google, GHL, Square…) — owner 11/27/2026.
  const serviceHealth = await timed("scanServiceHealth", () => scanServiceHealth(svc));
  // Merge exact duplicate Clients Master rows first, so the scans below see one row per client.
  // Quick: close "welcome texts NOT sent" when a teammate texted the logins by hand.
  const firstCycleLogins = await timed("scanFirstCycleLogins", () => scanFirstCycleLogins(svc));
  const [clientDupes, synced, deep, make, onboarding, dupes, ingest, agreement, notLive, silentLeads, doubleBookings, payDate, oneboxNotify] = [
    await timed("autoMergeClientDuplicates", () => autoMergeClientDuplicates(svc)),
    await timed("scanComplianceSynced", () => scanComplianceSynced(svc)),
    await timed("scanComplianceDeep", () => scanComplianceDeep(svc)),
    await timed("scanMakeScenarios", () => scanMakeScenarios(svc)),
    await timed("scanOnboardingPipeline", () => scanOnboardingPipeline(svc)),
    await timed("scanDuplicateLeads", () => scanDuplicateLeads(svc)),
    await timed("scanIngestHealth", () => scanIngestHealth(svc)),
    await timed("scanAgreementMissing", () => scanAgreementMissing(svc)),
    await timed("scanLeadsWhileNotLive", () => scanLeadsWhileNotLive(svc)),
    await timed("scanSilentLeads", () => scanSilentLeads(svc)),
    await timed("scanDoubleBookings", () => scanDoubleBookings(svc)),
    await timed("scanLiveNoPayDate", () => scanLiveNoPayDate(svc)),
    await timed("scanOneboxNotifyMissing", () => scanOneboxNotifyMissing(svc)),
  ];
  return NextResponse.json({ timestamp: new Date().toISOString(), ms, paidNets, serviceHealth, firstCycleLogins, clientDupes, synced, deep, make, onboarding, dupes, ingest, agreement, notLive, silentLeads, doubleBookings, payDate, oneboxNotify });
}
