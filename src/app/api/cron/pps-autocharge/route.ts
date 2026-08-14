import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { buildVerifyReport, executeChargeForRow, ChargeRefused } from "@/lib/ppa-verify";
import { squareConfigured } from "@/lib/square";

export const maxDuration = 300;

// Monday 10:00 America/Los_Angeles auto-charge for PPS clients that opted in.
//
// Vercel crons run in UTC and 10am Pacific is 17:00 UTC in summer (PDT) but
// 18:00 UTC in winter (PST). The cron fires at BOTH hours every Monday and
// this gate lets through only the one that is actually 10am on the West
// Coast — so the run happens exactly once, year-round, without anyone
// remembering to edit the schedule at DST changes.
function isMonday10Pacific(): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  return weekday === "Mon" && hour === 10;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!squareConfigured()) return NextResponse.json({ error: "Square is not configured." }, { status: 503 });

  // ?force=1 skips the time gate for a supervised manual test run.
  const force = req.nextUrl.searchParams.get("force") === "1";
  if (!force && !isMonday10Pacific()) {
    return NextResponse.json({ skipped: "Not Monday 10:00 Pacific — this firing is the other DST slot." });
  }

  const report = await buildVerifyReport();
  const runAt = new Date().toISOString();
  const svc = createServiceClient();

  type LogRow = {
    run_at: string; owner_key: string; owner_name: string; status: string;
    amount: number | null; shows: number | null; square_payment_id: string | null; detail: string | null;
  };
  const log: LogRow[] = [];

  // Only clients whose switch is ON and who have money waiting are considered.
  // Everything else is left alone silently — the log records decisions, not
  // the whole roster.
  for (const row of report.clients) {
    if (!row.autoCharge || row.readyToCharge === 0) continue;
    const base = { run_at: runAt, owner_key: row.ownerKey, owner_name: row.ownerName };

    // The cron holds a HARDER line than the manual button: any warning at all
    // (multiple cards unpicked, phone-only match, NOT ORGANIZED, paused…)
    // means skip and tell the human, because nobody is looking at a confirm
    // dialog. The manual button stays available for those.
    if (!row.safeToAutoCharge) {
      const reasons = row.flags.filter((f) => f.level !== "info").map((f) => f.message).join(" ");
      log.push({ ...base, status: "skipped", amount: row.amount, shows: row.readyToCharge, square_payment_id: null, detail: reasons || "Not verified." });
      continue;
    }

    try {
      const outcome = await executeChargeForRow(row, "auto-charge (Monday cron)");
      log.push({
        ...base, status: "charged", amount: outcome.amount, shows: outcome.shows,
        square_payment_id: outcome.paymentId,
        detail: outcome.warning ?? `${outcome.card}${outcome.receiptUrl ? ` · ${outcome.receiptUrl}` : ""}`,
      });
    } catch (e) {
      const msg = e instanceof ChargeRefused ? `Refused: ${e.message}` : (e instanceof Error ? e.message : "Charge failed");
      log.push({ ...base, status: "failed", amount: row.amount, shows: row.readyToCharge, square_payment_id: null, detail: msg });
    }
  }

  if (log.length) {
    const { error } = await svc.from("ppa_autocharge_log").insert(log);
    if (error) console.error("[pps-autocharge] log insert failed:", error.message);
  }

  const charged = log.filter((l) => l.status === "charged");
  console.log(`[pps-autocharge] charged=${charged.length} ($${charged.reduce((s, l) => s + (l.amount ?? 0), 0)}) skipped=${log.filter((l) => l.status === "skipped").length} failed=${log.filter((l) => l.status === "failed").length}`);
  return NextResponse.json({
    ranAt: runAt,
    charged: charged.length,
    chargedTotal: charged.reduce((s, l) => s + (l.amount ?? 0), 0),
    skipped: log.filter((l) => l.status === "skipped").length,
    failed: log.filter((l) => l.status === "failed").length,
    log,
  });
}
