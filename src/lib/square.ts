// Square API helpers (read-only: subscriptions, customers, plan catalog).
// Requires SQUARE_ACCESS_TOKEN in the environment. Set SQUARE_ENV=sandbox to
// hit the sandbox instead of production.

const BASE =
  process.env.SQUARE_ENV === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

export function squareConfigured(): boolean {
  return !!process.env.SQUARE_ACCESS_TOKEN;
}

export type SquareSubscription = {
  id: string;
  status: string;
  customerId: string | null;
  planVariationId: string | null;
  startDate: string | null;
  chargedThroughDate: string | null;
  canceledDate: string | null;
  monthlyBillingAnchor: number | null;
  priceOverrideCents: number | null;
  currency: string;
  latestInvoiceId: string | null;
  // Square keeps status ACTIVE when a pause is only scheduled, so the pending
  // action is the only way to know the subscription is on its way out.
  pauseScheduledOn: string | null;
  cancelScheduledOn: string | null;
};

// All subscriptions in the account (every status), paginated.
export async function listSubscriptions(): Promise<SquareSubscription[]> {
  const out: SquareSubscription[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    // include:["actions"] surfaces scheduled pauses/cancels. Without it a
    // "Pause Scheduled" subscription is indistinguishable from a plain active
    // one, because Square leaves status as ACTIVE until the date arrives.
    const body: Record<string, unknown> = { limit: 200, include: ["actions"] };
    if (cursor) body.cursor = cursor;
    const r = await fetch(`${BASE}/v2/subscriptions/search`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Square subscriptions ${r.status}: ${text.slice(0, 300)}`);
    }
    const j = (await r.json()) as { subscriptions?: Array<Record<string, unknown>>; cursor?: string };
    for (const s of j.subscriptions ?? []) {
      const priceOverride = s.price_override_money as { amount?: number; currency?: string } | undefined;
      // invoice_ids is newest-first; the latest invoice is the ground truth
      // for what this subscription actually charges.
      const invoiceIds = (s.invoice_ids as string[] | undefined) ?? [];
      const actions = (s.actions as Array<Record<string, unknown>> | undefined) ?? [];
      const actionOn = (type: string): string | null => {
        const hit = actions.find((a) => String(a.type ?? "").toUpperCase() === type);
        return hit ? ((hit.effective_date as string) ?? null) : null;
      };
      out.push({
        id: String(s.id),
        status: String(s.status ?? ""),
        customerId: (s.customer_id as string) ?? null,
        planVariationId: (s.plan_variation_id as string) ?? (s.plan_id as string) ?? null,
        startDate: (s.start_date as string) ?? null,
        chargedThroughDate: (s.charged_through_date as string) ?? null,
        canceledDate: (s.canceled_date as string) ?? null,
        monthlyBillingAnchor: typeof s.monthly_billing_anchor_date === "number" ? (s.monthly_billing_anchor_date as number) : null,
        priceOverrideCents: priceOverride?.amount ?? null,
        currency: priceOverride?.currency ?? "USD",
        latestInvoiceId: invoiceIds[0] ?? null,
        pauseScheduledOn: actionOn("PAUSE"),
        cancelScheduledOn: actionOn("CANCEL"),
      });
    }
    cursor = j.cursor;
    if (!cursor) break;
  }
  return out;
}

export type SquareCustomer = { id: string; name: string; email: string | null };

// In-process caches (warm serverless instance): customer names and plan
// details change rarely, so repeat loads skip most Square calls entirely.
const customerCache = new Map<string, { ts: number; c: SquareCustomer }>();
const CUSTOMER_TTL_MS = 60 * 60 * 1000; // 1h
const planCache = new Map<string, { ts: number; p: SquarePlan }>();
const PLAN_TTL_MS = 6 * 60 * 60 * 1000; // 6h
// Invoice amounts never change once issued — cache for the process lifetime.
const invoiceCache = new Map<string, number | null>();

function customerFromRaw(id: string, c: Record<string, unknown>): SquareCustomer {
  const name =
    `${c.given_name ?? ""} ${c.family_name ?? ""}`.trim() ||
    String(c.company_name ?? "").trim() ||
    String(c.email_address ?? "").trim() ||
    id;
  return { id, name, email: (c.email_address as string) ?? null };
}

// Bulk customer lookup (100 ids per call) so large accounts stay fast —
// individual GETs made the route time out on accounts with many customers.
export async function getCustomers(ids: string[]): Promise<Map<string, SquareCustomer>> {
  const map = new Map<string, SquareCustomer>();
  const now = Date.now();
  const missing: string[] = [];
  for (const id of ids) {
    const hit = customerCache.get(id);
    if (hit && now - hit.ts < CUSTOMER_TTL_MS) map.set(id, hit.c);
    else missing.push(id);
  }
  const chunk = 100;
  for (let i = 0; i < missing.length; i += chunk) {
    const slice = missing.slice(i, i + chunk);
    try {
      const r = await fetch(`${BASE}/v2/customers/bulk-retrieve`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ customer_ids: slice }),
      });
      if (r.ok) {
        const j = (await r.json()) as { responses?: Record<string, { customer?: Record<string, unknown> }> };
        for (const [id, resp] of Object.entries(j.responses ?? {})) {
          if (resp?.customer) {
            const c = customerFromRaw(id, resp.customer);
            map.set(id, c);
            customerCache.set(id, { ts: now, c });
          }
        }
        continue;
      }
    } catch {
      /* fall through to individual fetches */
    }
    // Fallback (bulk endpoint unavailable): individual fetches, concurrency 8.
    for (let k = 0; k < slice.length; k += 8) {
      await Promise.all(
        slice.slice(k, k + 8).map(async (id) => {
          try {
            const r = await fetch(`${BASE}/v2/customers/${id}`, { headers: headers() });
            if (!r.ok) return;
            const j = (await r.json()) as { customer?: Record<string, unknown> };
            if (j.customer) {
              const c = customerFromRaw(id, j.customer);
              map.set(id, c);
              customerCache.set(id, { ts: now, c });
            }
          } catch {
            /* best-effort; name falls back to id */
          }
        })
      );
    }
  }
  return map;
}

// ── Disputes (chargebacks) ───────────────────────────────────────────────────
export type SquareDispute = {
  id: string;
  state: string;            // e.g. EVIDENCE_REQUIRED, PROCESSING, WON, LOST, ACCEPTED
  reason: string;           // e.g. NOT_AS_DESCRIBED, NO_KNOWLEDGE, PRODUCT_NOT_RECEIVED
  amountCents: number;
  currency: string;
  dueAt: string | null;     // evidence deadline
  reportedAt: string | null;
  cardBrand: string | null;
  paymentId: string | null;
};

export async function listDisputes(): Promise<SquareDispute[]> {
  const out: SquareDispute[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const url = new URL(`${BASE}/v2/disputes`);
    if (cursor) url.searchParams.set("cursor", cursor);
    const r = await fetch(url.toString(), { headers: headers() });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Square disputes ${r.status}: ${text.slice(0, 300)}`);
    }
    const j = (await r.json()) as { disputes?: Array<Record<string, unknown>>; cursor?: string };
    for (const d of j.disputes ?? []) {
      const amt = d.amount_money as { amount?: number; currency?: string } | undefined;
      const pay = d.disputed_payment as { payment_id?: string } | undefined;
      out.push({
        id: String(d.id ?? d.dispute_id ?? ""),
        state: String(d.state ?? ""),
        reason: String(d.reason ?? ""),
        amountCents: amt?.amount ?? 0,
        currency: amt?.currency ?? "USD",
        dueAt: (d.due_at as string) ?? null,
        reportedAt: (d.reported_at as string) ?? (d.reported_date as string) ?? null,
        cardBrand: (d.card_brand as string) ?? null,
        paymentId: pay?.payment_id ?? null,
      });
    }
    cursor = j.cursor;
    if (!cursor) break;
  }
  return out;
}

export type SquarePayment = {
  id: string;
  createdAt: string | null;
  receiptNumber: string | null;
  amountCents: number;
  customerId: string | null;
  buyerEmail: string | null;
  cardLast4: string | null;
  note: string | null;
};

export async function getPayment(id: string): Promise<SquarePayment | null> {
  try {
    const r = await fetch(`${BASE}/v2/payments/${id}`, { headers: headers() });
    if (!r.ok) return null;
    const j = (await r.json()) as { payment?: Record<string, unknown> };
    const p = j.payment;
    if (!p) return null;
    const amt = p.amount_money as { amount?: number } | undefined;
    const card = (p.card_details as { card?: { last_4?: string } } | undefined)?.card;
    return {
      id: String(p.id),
      createdAt: (p.created_at as string) ?? null,
      receiptNumber: (p.receipt_number as string) ?? null,
      amountCents: amt?.amount ?? 0,
      customerId: (p.customer_id as string) ?? null,
      buyerEmail: (p.buyer_email_address as string) ?? null,
      cardLast4: card?.last_4 ?? null,
      note: (p.note as string) ?? null,
    };
  } catch {
    return null;
  }
}

export type SquarePlan = { id: string; name: string; cadence: string; priceCents: number | null };

// Amount actually billed on each invoice (in cents), keyed by invoice id.
// This is the reliable price source: plan-phase prices miss relative-priced
// plans entirely and can reflect an intro phase rather than the ongoing one.
export async function getInvoiceAmounts(ids: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const missing: string[] = [];
  for (const id of ids) {
    const hit = invoiceCache.get(id);
    if (hit !== undefined) {
      if (hit != null) map.set(id, hit);
    } else missing.push(id);
  }
  const chunk = 8;
  for (let i = 0; i < missing.length; i += chunk) {
    await Promise.all(
      missing.slice(i, i + chunk).map(async (id) => {
        try {
          const r = await fetch(`${BASE}/v2/invoices/${id}`, { headers: headers() });
          if (!r.ok) { invoiceCache.set(id, null); return; }
          const j = (await r.json()) as {
            invoice?: { payment_requests?: Array<{ computed_amount_money?: { amount?: number } }> };
          };
          const amount = (j.invoice?.payment_requests ?? [])
            .map((p) => p.computed_amount_money?.amount ?? 0)
            .reduce((s, a) => s + a, 0);
          invoiceCache.set(id, amount > 0 ? amount : null);
          if (amount > 0) map.set(id, amount);
        } catch {
          /* best-effort */
        }
      })
    );
  }
  return map;
}

export async function getPlans(ids: string[]): Promise<Map<string, SquarePlan>> {
  const map = new Map<string, SquarePlan>();
  const now = Date.now();
  const missing: string[] = [];
  for (const id of ids) {
    const hit = planCache.get(id);
    if (hit && now - hit.ts < PLAN_TTL_MS) map.set(id, hit.p);
    else missing.push(id);
  }
  const chunk = 8;
  for (let i = 0; i < missing.length; i += chunk) {
    await Promise.all(
      missing.slice(i, i + chunk).map(async (id) => {
        try {
          const r = await fetch(`${BASE}/v2/catalog/object/${id}`, { headers: headers() });
          if (!r.ok) return;
          const j = (await r.json()) as { object?: Record<string, unknown> };
          const obj = j.object;
          if (!obj) return;
          const data = (obj.subscription_plan_variation_data ?? obj.subscription_plan_data) as
            | { name?: string; phases?: Array<Record<string, unknown>> }
            | undefined;
          // Use the LAST phase — that's the ongoing price. Phase 0 can be an
          // intro/trial price, which made some amounts show wrong.
          const phases = data?.phases ?? [];
          const phase = phases[phases.length - 1] as
            | { cadence?: string; pricing?: { price_money?: { amount?: number } }; recurring_price_money?: { amount?: number } }
            | undefined;
          const p: SquarePlan = {
            id,
            name: data?.name ?? "Subscription",
            cadence: phase?.cadence ?? "",
            priceCents: phase?.pricing?.price_money?.amount ?? phase?.recurring_price_money?.amount ?? null,
          };
          map.set(id, p);
          planCache.set(id, { ts: now, p });
        } catch {
          /* best-effort */
        }
      })
    );
  }
  return map;
}
