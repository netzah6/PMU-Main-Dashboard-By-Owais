import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { getPaidLinkOrders, listPaymentLinks, squareConfigured } from "@/lib/square";
import { settleOpenLinks } from "@/lib/ppa-links";

export const maxDuration = 300;

// Every 10 minutes: mark the shows of PPA payment links that Square says are
// paid (matched by the link's own order id only — see src/lib/ppa-links.ts).
// Cron secret, or an admin.
//
// ?audit=1 (admin): one-off look at links made BEFORE 11/10/2026, which were
// never saved. Lists every Square link whose note starts "PPA " (only the
// PPA Billing tab writes that note), whether it was paid, and whether that
// Square payment is recorded on any show. Read-only — it changes nothing.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronOk = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const audit = req.nextUrl.searchParams.get("audit") === "1";
  if (!cronOk || audit) {
    const auth = await getAuth();
    if (!auth || auth.role !== "admin") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!squareConfigured()) return NextResponse.json({ skipped: "Square not configured" });

  if (!audit) {
    try {
      const results = await settleOpenLinks();
      if (results.length) console.log(`[ppa-link-check] ${results.map((r) => `${r.ownerKey}: ${r.status} (${r.marked})`).join("; ")}`);
      return NextResponse.json({ settled: results.length, results });
    } catch (e) {
      console.error("[ppa-link-check] failed:", e);
      return NextResponse.json({ error: e instanceof Error ? e.message : "link check failed" }, { status: 502 });
    }
  }

  const svc = createServiceClient();
  const all = await listPaymentLinks();
  const ppa = all.filter((l) => (l.note ?? "").startsWith("PPA "));
  const { data: tracked } = await svc.from("ppa_payment_links").select("square_order_id");
  const trackedIds = new Set(((tracked ?? []) as Array<{ square_order_id: string }>).map((r) => r.square_order_id));
  const old = ppa.filter((l) => l.orderId && !trackedIds.has(l.orderId));
  const paid = await getPaidLinkOrders(old.map((l) => l.orderId as string));

  const paymentIds = [...paid.values()].map((p) => p.paymentId);
  const { data: rec } = paymentIds.length
    ? await svc.from("ppa_charges").select("square_payment_id").in("square_payment_id", paymentIds)
    : { data: [] };
  const recorded = new Set(((rec ?? []) as Array<{ square_payment_id: string }>).map((r) => r.square_payment_id));

  const rows = old.map((l) => {
    const p = paid.get(l.orderId as string);
    return {
      createdAt: l.createdAt,
      note: l.note,
      url: l.url,
      paid: !!p,
      paidAmount: p ? p.amountCents / 100 : null,
      paidAt: p?.paidAt ?? null,
      squarePaymentId: p?.paymentId ?? null,
      // Hand-marked shows carry no Square id, so "false" means "not tied by
      // id" — the shows may still have been marked by hand. Check the client.
      recordedById: p ? recorded.has(p.paymentId) : null,
    };
  }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  return NextResponse.json({
    squareLinksTotal: all.length,
    ppaLinks: ppa.length,
    oldUntracked: rows.length,
    paid: rows.filter((r) => r.paid).length,
    paidNotTiedById: rows.filter((r) => r.paid && !r.recordedById).length,
    unpaidStillOpen: rows.filter((r) => !r.paid).length,
    rows,
  });
}
