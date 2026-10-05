import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { ingestRow, resolveTable } from "@/lib/direct-ingest";
import { routeIncomingPayment } from "@/lib/payment-router";

// Single intake endpoint for every direct row: Make.com posts each new deposit,
// lead, booking, call and signed agreement straight here, and we write straight
// to Supabase. No Google Sheet in the read path.
//
// Why one endpoint rather than one per table: Make's URL editor silently drops
// the final path segment when saving (verified three ways — ".../api/webhooks/
// deposit" always persisted as ".../api/webhooks"), so the destination table
// travels in the BODY, where it survives. Omitting it means deposits, which is
// how the original deposit module was configured before the other tables
// existed.

// Headroom over the ~1s this normally takes, so a cold start or a slow Supabase
// round trip can't turn into a timeout that Make records as a failed execution.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  // Shared-secret auth. Accepts a dedicated secret, or falls back to CRON_SECRET
  // so this works without provisioning a new env var first.
  const expected = process.env.DEPOSIT_WEBHOOK_SECRET || process.env.CRON_SECRET;
  if (expected) {
    const got =
      req.headers.get("x-webhook-secret") ||
      (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") ||
      new URL(req.url).searchParams.get("secret") ||
      "";
    if (got !== expected) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  /* Routing signal from the Make catch-all (one module, fires on every
     Commas payment): route the payment to the client's GHL if they're on
     dashboard routing, but do NOT record a deposit row — for route-covered
     clients the sheet path stays the single source, so no duplicate rows.
     The payment id doubles as the once-only claim key. */
  if (String(body.route_only ?? "") === "1") {
    const extId = String(body.payment_id ?? body.transaction_id ?? body.fanbasis_payment_id ?? "").trim();
    waitUntil(
      routeIncomingPayment(body, { externalId: extId || undefined })
        .then(async (r) => {
          if (r.outcome !== "skipped" || !/^no product id/.test(r.note)) {
            console.log("[payment-router]", JSON.stringify(r));
          }
          /* A dashboard-routed client has no Make route of their own, so
             nothing else ever records their deposit — Beauty By Size's two
             payments reached GHL but never the dashboard (2026-10-05).
             Record it here for exactly those clients ("sent", or "conflict"
             = this payment was already router-claimed). Legacy Make-routed
             clients stay sheet-recorded — their skips never reach this.
             ingestRow is idempotent on the payment id, so a re-delivered
             webhook can't double-record. */
          if (r.outcome === "sent" || r.outcome === "conflict") {
            try {
              const rec = await ingestRow("deposits", body);
              console.log("[payment-router] recorded:", JSON.stringify(rec).slice(0, 200));
            } catch (e) {
              console.error("[payment-router] record failed", e);
            }
          }
        })
        .catch((e) => console.error("[payment-router]", e))
    );
    return NextResponse.json({ ok: true, action: "route-only" });
  }

  const rawTable = body.table ?? body.sheet ?? body.sheetName ?? body.type;
  const table = rawTable == null || String(rawTable).trim() === "" ? "deposits" : resolveTable(rawTable);
  if (!table) {
    return NextResponse.json(
      {
        error: `unknown table: ${String(rawTable)}`,
        accepts: ["deposits", "leads_master", "bookings", "outgoing_calls", "signed_agreements"],
      },
      { status: 400 }
    );
  }

  const result = await ingestRow(table, body);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status ?? 500 });
  }

  /* Deposit payments also drive the client's GHL automations. For clients
     opted into dashboard routing (extras.paymentRouter) this replays the
     payment to their "FanBasis to GHL workflow" — replacing their Make
     route. Off the response's clock; a routing failure never fails the
     ingest. The externalId claim makes this once-per-payment no matter how
     often the row is re-delivered. Log line stays quiet only for payloads
     with no product id (lead/booking-shaped rows) — every real payment's
     outcome, including skips, is visible in the function logs. */
  if (table === "deposits") {
    waitUntil(
      routeIncomingPayment(body, { externalId: result.externalId })
        .then((r) => {
          if (r.outcome !== "skipped" || !/^no product id/.test(r.note)) {
            console.log("[payment-router]", JSON.stringify(r));
          }
        })
        .catch((e) => console.error("[payment-router]", e))
    );
  }

  return NextResponse.json(result);
}

// Lets you confirm the endpoint is live from a browser without sending data.
export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: "direct row intake",
    method: "POST",
    auth: "x-webhook-secret header (or Bearer / ?secret=)",
    table: 'body field "table" — deposits (default) | leads_master | bookings | outgoing_calls | signed_agreements',
    accepts: [
      "Full Name (or first_name + last_name)",
      "Email", "Phone Number", "Business Name", "Date",
      "Amount + Product ID (deposits only)",
      "external_id (idempotency key; derived from the row's content when absent)",
      "row_number (the sheet row Make just created, when available)",
    ],
  });
}
