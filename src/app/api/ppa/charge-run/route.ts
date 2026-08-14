import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { buildVerifyReport } from "@/lib/ppa-verify";
import { createCardPayment, squareConfigured } from "@/lib/square";

export const maxDuration = 120;

// The green light: charge ONE client's ready shows on their verified card.
// This is the only route in the dashboard that moves money, so it re-verifies
// everything server-side at the moment of charging — the client's view of the
// report is never trusted:
//   - the roster row, shows, fee, customer match and card are all rebuilt live
//   - any BLOCK-level flag refuses the charge (warnings were shown in the UI
//     and confirmed by the human clicking)
//   - the idempotency key is derived from the exact set of appointments being
//     billed, so a double-click, retry, or two admins racing produce ONE
//     Square payment, never two
export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!squareConfigured()) return NextResponse.json({ error: "Square is not configured." }, { status: 503 });

  const body = (await req.json().catch(() => ({}))) as { owner_key?: string; expected_amount?: number };
  const ownerKey = String(body.owner_key ?? "").trim().toLowerCase();
  if (!ownerKey) return NextResponse.json({ error: "owner_key required" }, { status: 400 });

  // Rebuild the verification for just this client, live.
  const report = await buildVerifyReport(ownerKey);
  const row = report.clients[0];
  if (!row) return NextResponse.json({ error: "Not a PPS client." }, { status: 404 });
  if (row.readyToCharge === 0) return NextResponse.json({ error: "Nothing to charge — no ready shows." }, { status: 400 });

  const blocks = row.flags.filter((f) => f.level === "block");
  if (blocks.length) {
    return NextResponse.json({
      error: `Refusing to charge — ${blocks.map((b) => b.message).join(" ")}`,
    }, { status: 409 });
  }
  if (!row.match) return NextResponse.json({ error: "No Square customer matched." }, { status: 409 });
  const card = row.cards.find((c) => c.wouldCharge);
  if (!card) return NextResponse.json({ error: "No usable card to charge." }, { status: 409 });

  // The UI shows an amount and the human confirms THAT amount. If the data
  // moved between render and click (a new show came in, a fee changed), the
  // amounts disagree — stop and make them look again rather than charge a
  // number they never saw.
  if (body.expected_amount != null && Number(body.expected_amount) !== row.amount) {
    return NextResponse.json({
      error: `The amount changed since you looked: it is now $${row.amount} (you confirmed $${body.expected_amount}). Re-check and try again.`,
    }, { status: 409 });
  }

  const apptIds = row.shows.map((s) => s.apptId).sort();
  // Same client + same exact show set → same key → Square returns the one
  // existing payment instead of creating another. Max 45 chars for Square.
  const idempotencyKey = createHash("sha256")
    .update(`pps:${ownerKey}:${apptIds.join(",")}`)
    .digest("hex")
    .slice(0, 45);

  let payment;
  try {
    payment = await createCardPayment({
      customerId: row.match.customerId,
      cardId: card.id,
      amountCents: Math.round(row.amount * 100),
      idempotencyKey,
      note: `PPS ${row.readyToCharge} show${row.readyToCharge === 1 ? "" : "s"} × $${row.fee} — ${row.ownerName} (${row.business})`,
      referenceId: ownerKey,
    });
  } catch (e) {
    // Card declined, token lacks PAYMENTS_WRITE, etc. Nothing was recorded, so
    // the row stays in "ready to charge" and can be retried safely.
    return NextResponse.json({ error: e instanceof Error ? e.message : "Square payment failed" }, { status: 502 });
  }

  // Mark every included appointment charged, carrying the Square payment id so
  // any later dispute can be traced back to the exact shows it covered.
  const now = new Date().toISOString();
  const svc = createServiceClient();
  const { error } = await svc.from("ppa_charges").upsert(
    apptIds.map((apptId) => ({
      appt_id: apptId,
      owner_key: ownerKey,
      charged: true,
      amount: row.fee,
      charged_at: now,
      charged_by: auth.email,
      square_payment_id: payment.id,
      note: `Square ${payment.id}`,
      excluded: false,
      exclude_reason: null,
      updated_at: now,
    })),
    { onConflict: "appt_id" }
  );
  // The payment already went through — a bookkeeping failure must be loud but
  // must NOT read as "charge failed" (retrying would be safe thanks to the
  // idempotency key, but the human needs to know money moved).
  if (error) {
    return NextResponse.json({
      ok: true,
      paymentId: payment.id,
      receiptUrl: payment.receiptUrl,
      warning: `CHARGED $${row.amount} (Square ${payment.id}) but recording it in the dashboard failed: ${error.message}. Mark the appointments charged manually.`,
    });
  }

  return NextResponse.json({
    ok: true,
    paymentId: payment.id,
    receiptUrl: payment.receiptUrl,
    status: payment.status,
    amount: row.amount,
    shows: row.readyToCharge,
    card: `${card.brand} ••${card.last4}`,
  });
}
