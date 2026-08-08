import { NextRequest, NextResponse } from "next/server";
import { ingestRow, resolveTable } from "@/lib/direct-ingest";

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
