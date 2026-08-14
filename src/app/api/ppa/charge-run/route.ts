import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { buildVerifyReport, executeChargeForRow, ChargeRefused } from "@/lib/ppa-verify";
import { squareConfigured } from "@/lib/square";

export const maxDuration = 120;

// The manual green light: charge ONE client's ready shows on their verified
// card. Everything is re-verified server-side at the moment of charging — the
// client's view of the report is never trusted. The actual charge logic (and
// its idempotency guarantee) lives in executeChargeForRow, shared with the
// Monday auto-charge cron so both paths enforce identical rules.
export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!squareConfigured()) return NextResponse.json({ error: "Square is not configured." }, { status: 503 });

  const body = (await req.json().catch(() => ({}))) as { owner_key?: string; expected_amount?: number };
  const ownerKey = String(body.owner_key ?? "").trim().toLowerCase();
  if (!ownerKey) return NextResponse.json({ error: "owner_key required" }, { status: 400 });

  const report = await buildVerifyReport(ownerKey);
  const row = report.clients[0];
  if (!row) return NextResponse.json({ error: "Not a PPS client." }, { status: 404 });

  // The UI shows an amount and the human confirms THAT amount. If the data
  // moved between render and click (a new show came in, a fee changed), the
  // amounts disagree — stop and make them look again rather than charge a
  // number they never saw.
  if (body.expected_amount != null && Number(body.expected_amount) !== row.amount) {
    return NextResponse.json({
      error: `The amount changed since you looked: it is now $${row.amount} (you confirmed $${body.expected_amount}). Re-check and try again.`,
    }, { status: 409 });
  }

  try {
    const outcome = await executeChargeForRow(row, auth.email ?? "admin");
    return NextResponse.json({ ok: true, ...outcome });
  } catch (e) {
    if (e instanceof ChargeRefused) {
      return NextResponse.json({ error: `Refusing to charge — ${e.message}` }, { status: 409 });
    }
    // Card declined, token lacks PAYMENTS_WRITE, etc. Nothing was recorded, so
    // the row stays in "ready to charge" and can be retried safely.
    return NextResponse.json({ error: e instanceof Error ? e.message : "Square payment failed" }, { status: 502 });
  }
}
