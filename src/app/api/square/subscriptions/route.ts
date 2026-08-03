import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { squareConfigured, listSubscriptions, getCustomers, getPlans, getInvoiceAmounts, actionsIncluded } from "@/lib/square";

// Resolving customers/plans/invoices for the live subs pushes this to ~80s on
// a full account. At the old 120s ceiling a slow Square response tipped it into
// a gateway timeout, and the tab then showed an error or a stale list — i.e.
// subscriptions silently missing from a page people trust to be complete.
export const maxDuration = 300;

// All Square subscriptions with customer names, plan info, and charge dates.
export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!squareConfigured()) {
    return NextResponse.json(
      { error: "Square is not configured yet — add SQUARE_ACCESS_TOKEN to the dashboard environment." },
      { status: 503 }
    );
  }

  try {
    const subs = await listSubscriptions();
    // Resolve customer names only for non-canceled subscriptions — accounts can
    // have hundreds of canceled ones, and resolving them all caused timeouts.
    // Canceled rows fall back to the raw customer id.
    const isEnded = (s: string) => ["CANCELED", "DEACTIVATED"].includes(s.toUpperCase());
    const live = subs.filter((s) => !isEnded(s.status));
    // Square leaves status ACTIVE while a pause is merely scheduled. Treat that
    // as paused — it's leaving, and counting it as active overstates both the
    // active roster and the monthly total.
    const effectiveStatus = (s: (typeof subs)[number]) =>
      s.status.toUpperCase() === "ACTIVE" && s.pauseScheduledOn ? "PAUSE SCHEDULED" : s.status;
    const customerIds = Array.from(new Set(live.map((s) => s.customerId).filter(Boolean))) as string[];
    // Plans too: only for live subs — canceled ones can reference hundreds of
    // old plan variations and the catalog lookups were timing out the route.
    const planIds = Array.from(new Set(live.map((s) => s.planVariationId).filter(Boolean))) as string[];
    const invoiceIds = Array.from(new Set(live.map((s) => s.latestInvoiceId).filter(Boolean))) as string[];
    const t0 = Date.now();
    const [customers, plans, invoiceAmounts] = await Promise.all([
      getCustomers(customerIds),
      getPlans(planIds),
      getInvoiceAmounts(invoiceIds),
    ]);
    console.log(`[square] subs=${subs.length} live=${live.length} customers=${customerIds.length} plans=${planIds.length} invoices=${invoiceIds.length} lookupMs=${Date.now() - t0}`);

    const rows = subs.map((s) => {
      const plan = s.planVariationId ? plans.get(s.planVariationId) : undefined;
      const customer = s.customerId ? customers.get(s.customerId) : undefined;
      return {
        id: s.id,
        status: effectiveStatus(s),
        squareStatus: s.status, // what Square itself reports, before our reading of it
        pauseScheduledOn: s.pauseScheduledOn,
        cancelScheduledOn: s.cancelScheduledOn,
        customerName: customer?.name ?? s.customerId ?? "—",
        customerEmail: customer?.email ?? null,
        planName: plan?.name ?? "Subscription",
        cadence: plan?.cadence ?? "",
        // Latest invoice = what Square actually billed (handles relative-priced
        // plans and multi-phase plans); overrides and plan price are fallbacks.
        amountCents:
          (s.latestInvoiceId ? invoiceAmounts.get(s.latestInvoiceId) : undefined) ??
          s.priceOverrideCents ??
          plan?.priceCents ??
          null,
        currency: s.currency,
        startDate: s.startDate,
        chargedThroughDate: s.chargedThroughDate,
        canceledDate: s.canceledDate,
        monthlyBillingAnchor: s.monthlyBillingAnchor,
      };
    });

    // Duplicate ACTIVE subscriptions for one customer mean they get billed
    // twice. Surfaced here so the tab can warn rather than leaving it to be
    // noticed on a statement.
    const activeByCustomer = new Map<string, number>();
    for (const r of rows) {
      if (r.status.toUpperCase() !== "ACTIVE") continue;
      const key = (r.customerEmail || r.customerName || r.id).toLowerCase().trim();
      activeByCustomer.set(key, (activeByCustomer.get(key) ?? 0) + 1);
    }
    const duplicateActive = rows
      .filter((r) => r.status.toUpperCase() === "ACTIVE" &&
        (activeByCustomer.get((r.customerEmail || r.customerName || r.id).toLowerCase().trim()) ?? 0) > 1)
      .map((r) => r.customerName);

    return NextResponse.json({
      subscriptions: rows,
      // Totals straight from Square, so a short list is visibly a short list.
      // False when Square couldn't serve the scheduled-actions payload, so the
      // tab can say pause/cancel detection was unavailable rather than imply
      // there simply weren't any.
      scheduledActionsAvailable: actionsIncluded,
      counts: {
        total: rows.length,
        byStatus: rows.reduce<Record<string, number>>((a, r) => {
          a[r.status.toUpperCase()] = (a[r.status.toUpperCase()] ?? 0) + 1; return a;
        }, {}),
        duplicateActiveCustomers: Array.from(new Set(duplicateActive)).sort(),
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Square request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
