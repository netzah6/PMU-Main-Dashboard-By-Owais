import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { buildVerifyReport, executeChargeForRow, restrictRowToShows, ChargeRefused } from "@/lib/ppa-verify";
import { isDeclineError, scheduleRetry, resolveRetry, RETRY_OFFSETS_DAYS } from "@/lib/ppa-retry";
import { squareConfigured } from "@/lib/square";

export const maxDuration = 120;

// The manual green light: charge ONE client's ready shows on their verified
// card. Everything is re-verified server-side at the moment of charging — the
// client's view of the report is never trusted. The actual charge logic (and
// its idempotency guarantee) lives in executeChargeForRow, shared with the
// Monday auto-charge cron so both paths enforce identical rules.
//
// `appt_ids` is the partial charge (owner request 2026-09-26): collect only
// those ready shows and leave the rest in Ready. The selection is intersected
// with the freshly built report by restrictRowToShows, so it can only ever
// narrow the charge — a tampered or stale request cannot add a dollar.
export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!squareConfigured()) return NextResponse.json({ error: "Square is not configured." }, { status: 503 });

  const body = (await req.json().catch(() => ({}))) as { owner_key?: string; expected_amount?: number; appt_ids?: unknown };
  const ownerKey = String(body.owner_key ?? "").trim().toLowerCase();
  if (!ownerKey) return NextResponse.json({ error: "owner_key required" }, { status: 400 });

  const report = await buildVerifyReport(ownerKey);
  const fullRow = report.clients[0];
  if (!fullRow) return NextResponse.json({ error: "Not a PPS client." }, { status: 404 });

  // Partial charge: narrow the row to the picked shows, server-side, off the
  // report we just built. Anything that isn't a real subset of what is ready
  // right now is refused rather than approximated.
  let row = fullRow;
  /* Absent appt_ids = charge everything ready (the full-charge path). But an
     appt_ids that was SENT and is empty — [] , or ["", " "] once blanks are
     dropped — is a partial charge that selected nothing, and must be refused.
     Falling through to the full amount there would over-charge the client. */
  const sentPick: unknown[] | null = Array.isArray(body.appt_ids) ? body.appt_ids : null;
  const picked = sentPick ? [...new Set(sentPick.map((id) => String(id).trim()).filter(Boolean))] : [];
  if (sentPick && picked.length === 0) {
    return NextResponse.json({ error: "Refusing to charge — pick at least one show to charge." }, { status: 409 });
  }
  if (picked.length) {
    try {
      row = restrictRowToShows(fullRow, picked);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Bad show selection";
      return NextResponse.json({ error: `Refusing to charge — ${message}` }, { status: 409 });
    }
  }

  // The UI shows an amount and the human confirms THAT amount. If the data
  // moved between render and click (a new show came in, a fee changed), the
  // amounts disagree — stop and make them look again rather than charge a
  // number they never saw. For a partial this is the picked subset's amount.
  if (body.expected_amount != null && Number(body.expected_amount) !== row.amount) {
    return NextResponse.json({
      error: `The amount changed since you looked: it is now $${row.amount}${picked.length ? " for the shows you picked" : ""} (you confirmed $${body.expected_amount}). Re-check and try again.`,
    }, { status: 409 });
  }

  try {
    const outcome = await executeChargeForRow(row, auth.email ?? "admin");
    // Money collected — end any pending decline-retry loop for this client.
    // True after a partial too: a card that just took money is not declining,
    // and the shows left behind must not be swept up by an automatic retry the
    // admin never asked for. They stay in Ready for the next manual charge.
    await resolveRetry(ownerKey, "succeeded");
    // What is still owed after a partial, so the UI can say it without a
    // second round trip. Credit already spent on this charge is accounted for
    // (both amounts are net of it), and a full charge leaves zero.
    const remainingShows = fullRow.readyToCharge - row.readyToCharge;
    return NextResponse.json({
      ok: true,
      ...outcome,
      partial: remainingShows > 0,
      remainingShows,
      remainingAmount: Math.max(0, fullRow.amount - row.amount),
    });
  } catch (e) {
    if (e instanceof ChargeRefused) {
      return NextResponse.json({ error: `Refusing to charge — ${e.message}` }, { status: 409 });
    }
    const message = e instanceof Error ? e.message : "Square payment failed";
    // A DECLINE starts the automatic retry clock (+1d, +3d, +3d) — cards often
    // recover once funds land or a fraud hold lifts. Config errors don't
    // retry; they'd fail identically.
    if (isDeclineError(message)) {
      const next = await scheduleRetry(ownerKey, message, auth.email ?? "admin");
      return NextResponse.json({
        error: `${message} — the bank refused the card. I'll retry automatically ${RETRY_OFFSETS_DAYS.length} times (next: ${next.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}, then every 3 days). If all fail, use Payment link or get a new card on file.`,
        retryScheduled: true,
        nextAttemptAt: next.toISOString(),
      }, { status: 502 });
    }
    // Nothing was recorded, so the row stays in "ready to charge".
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
