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

  const body = (await req.json().catch(() => ({}))) as { owner_key?: string; appt_ids?: unknown };
  const ownerKey = String(body.owner_key ?? "").trim().toLowerCase();
  if (!ownerKey) return NextResponse.json({ error: "owner_key required" }, { status: 400 });

  const report = await buildVerifyReport(ownerKey);
  const row = report.clients[0];
  if (!row) return NextResponse.json({ error: "Not a PPA client." }, { status: 404 });
  if (row.readyToCharge === 0) return NextResponse.json({ error: "Nothing to collect — no ready shows." }, { status: 400 });

  // Owner 10/27/2026: a link for just the shows ticked in "Part", not always
  // the whole balance. Only ids that are actually ready count; the amount is
  // those shows × fee (no credit applied — credit is settled on a card charge).
  const picked = Array.isArray(body.appt_ids) ? new Set(body.appt_ids.map(String)) : null;
  const shows = picked ? row.shows.filter((s) => picked.has(s.apptId)) : row.shows;
  if (picked && shows.length === 0) return NextResponse.json({ error: "None of the ticked shows is ready to charge any more — refresh and try again." }, { status: 400 });
  const count = picked ? shows.length : row.readyToCharge;
  const amount = picked ? Math.round(count * row.fee * 100) / 100 : row.amount;
  const who = picked ? ` — ${shows.map((s) => s.contactName ?? "?").join(", ")}` : "";

  try {
    const link = await createPaymentLink({
      name: `PMU Bookings — ${count} show${count === 1 ? "" : "s"} × $${row.fee}`,
      amountCents: Math.round(amount * 100),
      referenceId: ownerKey,
      note: `PPA ${count} shows — ${row.ownerName} (${row.business})${who}`.slice(0, 500),
    });
    return NextResponse.json({
      ok: true,
      url: link.url,
      amount,
      shows: count,
      names: picked ? shows.map((s) => s.contactName ?? "?") : undefined,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Payment link failed" }, { status: 502 });
  }
}
