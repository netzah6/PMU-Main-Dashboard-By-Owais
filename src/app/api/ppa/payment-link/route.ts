import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { buildVerifyReport } from "@/lib/ppa-verify";
import { createPaymentLink, squareConfigured } from "@/lib/square";

export const maxDuration = 120;

// Fallback for a declined card on file: a Square-hosted checkout link for the
// client's CURRENT ready amount, to be sent to the artist by the admin. This
// route moves no money and records no charge — once the artist actually pays
// the link, the admin marks the shows charged in the drill-down (the payment
// note carries client + show count so the two are easy to tie together).
export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!squareConfigured()) return NextResponse.json({ error: "Square is not configured." }, { status: 503 });

  const body = (await req.json().catch(() => ({}))) as { owner_key?: string };
  const ownerKey = String(body.owner_key ?? "").trim().toLowerCase();
  if (!ownerKey) return NextResponse.json({ error: "owner_key required" }, { status: 400 });

  const report = await buildVerifyReport(ownerKey);
  const row = report.clients[0];
  if (!row) return NextResponse.json({ error: "Not a PPS client." }, { status: 404 });
  if (row.readyToCharge === 0) return NextResponse.json({ error: "Nothing to collect — no ready shows." }, { status: 400 });

  try {
    const link = await createPaymentLink({
      name: `PMU Bookings — ${row.readyToCharge} show${row.readyToCharge === 1 ? "" : "s"} × $${row.fee}`,
      amountCents: Math.round(row.amount * 100),
      referenceId: ownerKey,
      note: `PPS ${row.readyToCharge} shows — ${row.ownerName} (${row.business})`,
    });
    return NextResponse.json({
      ok: true,
      url: link.url,
      amount: row.amount,
      shows: row.readyToCharge,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Payment link failed" }, { status: 502 });
  }
}
