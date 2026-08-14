import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { buildVerifyReport, executeChargeForRow, ChargeRefused } from "@/lib/ppa-verify";
import { advanceRetry, resolveRetry, isDeclineError } from "@/lib/ppa-retry";
import { squareConfigured } from "@/lib/square";

export const maxDuration = 300;

// Daily decline-retry processor (10:00 Pacific, same dual-UTC-slot gate as the
// Monday auto-charge). Only clients with an ACTIVE retry row whose
// next_attempt_at has arrived are touched — this exists because a human
// pressed Charge, the card declined, and the user wants the card retried
// (+1d, +3d, +3d) before anyone bothers the artist.
//
// Retries hold the MANUAL bar (block flags stop them, warnings don't): the
// human already saw the warnings when they armed the original charge.
function is10Pacific(): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hour: "numeric", hour12: false,
  }).formatToParts(new Date());
  return Number(parts.find((p) => p.type === "hour")?.value) === 10;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!squareConfigured()) return NextResponse.json({ error: "Square is not configured." }, { status: 503 });
  const force = req.nextUrl.searchParams.get("force") === "1";
  if (!force && !is10Pacific()) {
    return NextResponse.json({ skipped: "Not 10:00 Pacific — this firing is the other DST slot." });
  }

  const svc = createServiceClient();
  const { data } = await svc
    .from("ppa_charge_retries")
    .select("owner_key, attempts")
    .eq("status", "active")
    .lte("next_attempt_at", new Date().toISOString());
  const due = (data ?? []) as Array<{ owner_key: string; attempts: number }>;
  if (!due.length) return NextResponse.json({ due: 0 });

  const runAt = new Date().toISOString();
  const log: Array<Record<string, unknown>> = [];
  const results: Array<Record<string, unknown>> = [];

  for (const r of due) {
    const base = { run_at: runAt, owner_key: r.owner_key };
    try {
      const report = await buildVerifyReport(r.owner_key);
      const row = report.clients[0];
      // Nothing left to collect (voided, or paid another way) — loop is over.
      if (!row || row.readyToCharge === 0) {
        await resolveRetry(r.owner_key, "cancelled");
        results.push({ ...base, outcome: "nothing_to_collect" });
        continue;
      }
      const outcome = await executeChargeForRow(row, `auto-retry #${r.attempts + 1}`);
      await resolveRetry(r.owner_key, "succeeded");
      log.push({ ...base, owner_name: row.ownerName, status: "charged", amount: outcome.amount, shows: outcome.shows, square_payment_id: outcome.paymentId, detail: `retry #${r.attempts + 1} · ${outcome.card}` });
      results.push({ ...base, outcome: "charged", amount: outcome.amount });
    } catch (e) {
      const message = e instanceof ChargeRefused ? `Refused: ${e.message}` : e instanceof Error ? e.message : "Charge failed";
      // A block flag (card removed, ambiguous match) isn't a decline — pause
      // by advancing anyway so the schedule doesn't spin on it daily.
      const adv = await advanceRetry(r.owner_key, r.attempts, message);
      log.push({ ...base, owner_name: r.owner_key, status: "failed", amount: null, shows: null, square_payment_id: null,
        detail: `retry #${r.attempts + 1} ${isDeclineError(message) ? "declined" : "failed"}: ${message}${adv.status === "exhausted" ? " — RETRIES EXHAUSTED, send a payment link or get a new card" : ` — next attempt ${adv.nextAt?.toISOString().slice(0, 10)}`}` });
      results.push({ ...base, outcome: adv.status, error: message });
    }
  }

  if (log.length) {
    const { error } = await svc.from("ppa_autocharge_log").insert(log);
    if (error) console.error("[pps-retry] log insert failed:", error.message);
  }
  console.log(`[pps-retry] due=${due.length} charged=${results.filter((x) => x.outcome === "charged").length}`);
  return NextResponse.json({ due: due.length, results });
}
