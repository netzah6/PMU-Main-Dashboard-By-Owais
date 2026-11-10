import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { buildVerifyReport } from "@/lib/ppa-verify";
import { createPaymentLink, squareConfigured } from "@/lib/square";
import { cancelLink, recordPaymentLink } from "@/lib/ppa-links";
import { createServiceClient } from "@/lib/supabase/server";

export const maxDuration = 120;

// Fallback for a declined card on file: a Square-hosted checkout link for the
// client's CURRENT ready amount, to be sent to the artist by the admin. This
// route moves no money and records no charge. Since 11/10/2026 the link is
// saved with its Square order id and the exact shows it covers, and
// /api/cron/ppa-link-check marks those shows charged once Square says that
// order is paid (see src/lib/ppa-links.ts) — nobody marks them by hand.
//
// Also: { action: "cancel", link_id } deletes an open link in Square, and
// { action: "reviewed", link_id } clears a "paid — check by hand" flag.
export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!squareConfigured()) return NextResponse.json({ error: "Square is not configured." }, { status: 503 });

  const body = (await req.json().catch(() => ({}))) as { owner_key?: string; appt_ids?: unknown; action?: string; link_id?: number };
  const ownerKey = String(body.owner_key ?? "").trim().toLowerCase();
  if (!ownerKey) return NextResponse.json({ error: "owner_key required" }, { status: 400 });

  if (body.action === "cancel" || body.action === "reviewed") {
    const svc = createServiceClient();
    const { data: link } = await svc.from("ppa_payment_links").select("id, status")
      .eq("id", Number(body.link_id)).eq("owner_key", ownerKey).maybeSingle();
    if (!link) return NextResponse.json({ error: "Link not found." }, { status: 404 });
    const now = new Date().toISOString();
    if (body.action === "reviewed") {
      if (link.status !== "paid_review") return NextResponse.json({ error: "Nothing to review on this link." }, { status: 400 });
      await svc.from("ppa_payment_links").update({ status: "paid", review_note: `Reviewed by ${auth.email}`, updated_at: now }).eq("id", link.id);
      return NextResponse.json({ ok: true });
    }
    if (link.status !== "open") return NextResponse.json({ error: "This link is not open any more." }, { status: 400 });
    // Deleted in Square first, then Square is asked whether she paid it in
    // the meantime — a paid link is flagged, never silently cancelled.
    const r = await cancelLink(link.id, auth.email ?? "admin");
    if (r === "not_deleted") return NextResponse.json({ error: "Square would not delete the link." }, { status: 502 });
    if (r === "paid_review") return NextResponse.json({ error: "She already paid this link — it is flagged on her row to check." }, { status: 409 });
    return NextResponse.json({ ok: true });
  }

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
  // Always the full fee per show. Account credit is never used in a link (it
  // could be spent twice if a card charge ran before she paid); it stays on
  // her balance for the next card charge.
  const amount = Math.round(count * row.fee * 100) / 100;
  const who = picked ? ` — ${shows.map((s) => s.contactName ?? "?").join(", ")}` : "";

  try {
    const link = await createPaymentLink({
      name: `PMU Bookings — ${count} show${count === 1 ? "" : "s"} × $${row.fee}`,
      amountCents: Math.round(amount * 100),
      referenceId: ownerKey,
      note: `PPA ${count} shows — ${row.ownerName} (${row.business})${who}`.slice(0, 500),
    });
    // Without the order id the link could never be matched — say so loudly
    // rather than hand out a link that silently stays unmatched.
    const saveErr = link.orderId
      ? await recordPaymentLink({
          ownerKey, squareLinkId: link.id, squareOrderId: link.orderId, url: link.url,
          amountCents: Math.round(amount * 100), fee: row.fee,
          shows: shows.map((s) => ({ appt_id: s.apptId, name: s.contactName ?? null })),
          createdBy: auth.email ?? "admin",
        })
      : "Square returned no order id";
    return NextResponse.json({
      ok: true,
      tracked: !saveErr,
      warning: saveErr ? `Link made, but it could NOT be saved for automatic matching (${saveErr}). When she pays, mark the shows charged by hand.` : undefined,
      url: link.url,
      amount,
      shows: count,
      names: picked ? shows.map((s) => s.contactName ?? "?") : undefined,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Payment link failed" }, { status: 502 });
  }
}
