import { createServiceClient } from "@/lib/supabase/server";
import { listSubscriptions, getCustomers, getPlans, getInvoiceAmounts, actionsIncluded } from "@/lib/square";

// Building the Square subscriptions view means walking every subscription on
// the account (~750, 100 per page with scheduled actions) and then resolving
// customers, plans and latest invoices for the live ones — around 80 seconds.
// Doing that on every page open made the tab feel broken. So the assembled
// payload is stored in square_subscriptions_snapshot: the tab reads that in
// milliseconds, a cron keeps it warm, and Refresh or any pause/resume rebuilds
// it on demand.

export const SNAPSHOT_FRESH_MS = 15 * 60 * 1000;

type Svc = ReturnType<typeof createServiceClient>;

export type SquareSnapshot = {
  payload: Record<string, unknown>;
  fetchedAt: string;
  durationMs: number | null;
  error: string | null;
};

/** The live build — the expensive part. */
export async function buildSquareSubscriptionsPayload(): Promise<Record<string, unknown>> {
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
        pauseActionId: s.pauseActionId,
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

    return {
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
    };
}

/** Rebuild from Square and store. Failures are recorded, not thrown, so the
 *  previous good snapshot stays available. */
export async function refreshSquareSnapshot(svc: Svc): Promise<SquareSnapshot> {
  const t0 = Date.now();
  try {
    const payload = await buildSquareSubscriptionsPayload();
    const row = { id: 1, payload, fetched_at: new Date().toISOString(), duration_ms: Date.now() - t0, error: null };
    await svc.from("square_subscriptions_snapshot").upsert(row);
    return { payload, fetchedAt: row.fetched_at, durationMs: row.duration_ms, error: null };
  } catch (e) {
    const error = e instanceof Error ? e.message : "Square request failed";
    // Keep the last good payload; just note that this attempt failed.
    await svc.from("square_subscriptions_snapshot").update({ error }).eq("id", 1);
    const prev = await readSquareSnapshot(svc);
    if (prev) return { ...prev, error };
    throw e;
  }
}

export async function readSquareSnapshot(svc: Svc): Promise<SquareSnapshot | null> {
  const { data } = await svc.from("square_subscriptions_snapshot").select("*").eq("id", 1).maybeSingle();
  if (!data?.payload) return null;
  return {
    payload: data.payload as Record<string, unknown>,
    fetchedAt: data.fetched_at as string,
    durationMs: (data.duration_ms as number) ?? null,
    error: (data.error as string) ?? null,
  };
}
