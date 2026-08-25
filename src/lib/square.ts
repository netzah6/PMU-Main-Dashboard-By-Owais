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
// Set to false when Square couldn't serve the richer payload, so callers can
// say that scheduled pauses weren't detectable on this run.
export let actionsIncluded = true;

export async function listSubscriptions(): Promise<SquareSubscription[]> {
  actionsIncluded = true;
  const out: SquareSubscription[] = [];
  let cursor: string | undefined;
  // include:["actions"] surfaces scheduled pauses/cancels — without it a
  // "Pause Scheduled" subscription is indistinguishable from a plain active
  // one, because Square leaves status ACTIVE until the date arrives. It also
  // makes each page heavier, and Square answered a full 200-row page with a
  // 504, so pages are smaller when actions are included and the whole thing
  // degrades to a plain listing rather than failing the tab outright.
  let withActions = true;
  for (let page = 0; page < 40; page++) {
    const body: Record<string, unknown> = withActions
      ? { limit: 100, include: ["actions"] }
      : { limit: 200 };
    if (cursor) body.cursor = cursor;

    let r: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await fetch(`${BASE}/v2/subscriptions/search`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body),
      });
      if (r.ok || r.status < 500) break;           // 4xx is ours to fix, don't retry
      await new Promise((s) => setTimeout(s, 1500 * (attempt + 1)));
    }
    if (!r) throw new Error("Square subscriptions: no response");
    if (!r.ok) {
      const text = await r.text();
      // Square struggling with the heavier payload shouldn't take the page
      // down — drop actions and carry on. Scheduled pauses stop being
      // detected, which the route reports rather than hides.
      if (r.status >= 500 && withActions) {
        withActions = false;
        actionsIncluded = false;
        cursor = undefined;
        out.length = 0;
        continue;
      }
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

export type SquareCustomer = {
  id: string;
  name: string;
  email: string | null;
  phone?: string | null;
  company?: string | null;
  createdAt?: string | null;
};

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
  return {
    id,
    name,
    email: (c.email_address as string) ?? null,
    phone: (c.phone_number as string) ?? null,
    company: (c.company_name as string) ?? null,
    createdAt: (c.created_at as string) ?? null,
  };
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

// ── Rate-limit-aware fetch ───────────────────────────────────────────────────
// Square throttles per-method: the first PPS payment-check run fired a search
// per client and everyone after the first few came back 429 ("this merchant
// has exceeded the number of requests for this method"), which the report
// rendered as a sea of red. Retry 429s (honoring Retry-After) and 5xx with
// backoff instead of failing the row.
async function squareFetch(url: string, init?: RequestInit): Promise<Response> {
  let r: Response | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    r = await fetch(url, { ...init, headers: headers() });
    if (r.ok || (r.status !== 429 && r.status < 500)) return r;
    const retryAfter = Number(r.headers.get("retry-after")) || 0;
    const backoff = Math.max(retryAfter * 1000, 1000 * 2 ** attempt); // 1s,2s,4s,8s
    await new Promise((s) => setTimeout(s, backoff));
  }
  return r!;
}

// ── Targeted customer search ─────────────────────────────────────────────────
// Fallback for artists the bulk list misses (accounts bigger than the page
// cap). Only called for MISSES — a handful of requests through the retrying
// squareFetch, not the per-client storm that originally tripped the
// per-method rate limit.

async function searchCustomers(filter: Record<string, unknown>): Promise<SquareCustomer[]> {
  const r = await squareFetch(`${BASE}/v2/customers/search`, {
    method: "POST",
    body: JSON.stringify({ limit: 20, query: { filter } }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Square customer search ${r.status}: ${text.slice(0, 300)}`);
  }
  const j = (await r.json()) as { customers?: Array<Record<string, unknown>> };
  return (j.customers ?? []).map((c) => customerFromRaw(String(c.id), c));
}

export function searchCustomersByEmail(email: string): Promise<SquareCustomer[]> {
  return searchCustomers({ email_address: { exact: email } });
}

export function searchCustomersByPhone(phone: string): Promise<SquareCustomer[]> {
  return searchCustomers({ phone_number: { fuzzy: phone } });
}

// ── The full customer list ───────────────────────────────────────────────────
// Matching artists to Square customers reads the WHOLE list once and matches
// locally (email/phone/name) instead of calling SearchCustomers per client —
// per-client searches are what tripped the per-method rate limit.

let allCustomersCache: { ts: number; list: SquareCustomer[]; truncated: boolean } | null = null;
const ALL_CUSTOMERS_TTL_MS = 30 * 60 * 1000;
// Square auto-creates a customer profile for nearly every payment, so a
// mature account holds far more customers than it has real clients — the old
// 6,000 cap silently dropped artists past it (Abegail matched by email before
// the bulk-list rework, then read as "no Square customer" after it).
const ALL_CUSTOMERS_MAX_PAGES = 150; // 15,000 customers

// Every customer in the account, for name-based matching. Paginated and
// capped: `truncated` is true when the cap was hit, so a "no customer found"
// can be reported as "not found in the first N" rather than a flat no.
export async function listAllCustomers(): Promise<{ customers: SquareCustomer[]; truncated: boolean }> {
  const now = Date.now();
  if (allCustomersCache && now - allCustomersCache.ts < ALL_CUSTOMERS_TTL_MS)
    return { customers: allCustomersCache.list, truncated: allCustomersCache.truncated };

  const list: SquareCustomer[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; page < ALL_CUSTOMERS_MAX_PAGES; page++) {
    // Plain ListCustomers (GET) — a different rate bucket from the search
    // method, and no search features are needed for a full scan.
    const url = new URL(`${BASE}/v2/customers`);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const r = await squareFetch(url.toString());
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Square customers ${r.status}: ${text.slice(0, 300)}`);
    }
    const j = (await r.json()) as { customers?: Array<Record<string, unknown>>; cursor?: string };
    for (const c of j.customers ?? []) list.push(customerFromRaw(String(c.id), c));
    cursor = j.cursor;
    if (!cursor) break;
    if (page === ALL_CUSTOMERS_MAX_PAGES - 1) truncated = true;
  }
  allCustomersCache = { ts: now, list, truncated };
  return { customers: list, truncated };
}

// ── Cards on file ────────────────────────────────────────────────────────────
export type SquareCard = {
  id: string;
  brand: string;          // VISA, MASTERCARD, …
  last4: string;
  expMonth: number | null;
  expYear: number | null;
  cardholderName: string | null;
  enabled: boolean;       // a disabled card cannot be charged
  cardType: string | null;
  fingerprint: string | null;
};

// Cards a customer has on file, NEWEST FIRST. Square's Card object carries no
// created_at, so the sort order is the only signal for which card was added
// last — and Square has no "default card" flag at all, so whoever charges has
// to pick one deliberately.
export async function listCards(customerId: string, includeDisabled = true): Promise<SquareCard[]> {
  const out: SquareCard[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const url = new URL(`${BASE}/v2/cards`);
    url.searchParams.set("customer_id", customerId);
    url.searchParams.set("include_disabled", String(includeDisabled));
    url.searchParams.set("sort_order", "DESC");
    if (cursor) url.searchParams.set("cursor", cursor);
    const r = await squareFetch(url.toString());
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Square cards ${r.status}: ${text.slice(0, 300)}`);
    }
    const j = (await r.json()) as { cards?: Array<Record<string, unknown>>; cursor?: string };
    for (const c of j.cards ?? []) {
      out.push({
        id: String(c.id),
        brand: String(c.card_brand ?? "CARD"),
        last4: String(c.last_4 ?? "????"),
        expMonth: typeof c.exp_month === "number" ? c.exp_month : Number(c.exp_month) || null,
        expYear: typeof c.exp_year === "number" ? c.exp_year : Number(c.exp_year) || null,
        cardholderName: (c.cardholder_name as string) ?? null,
        enabled: c.enabled !== false,
        cardType: (c.card_type as string) ?? null,
        fingerprint: (c.fingerprint as string) ?? null,
      });
    }
    cursor = j.cursor;
    if (!cursor) break;
  }
  return out;
}

// ── Recent payments (which card did they actually last pay with?) ────────────
export type RecentPayment = {
  id: string;
  customerId: string | null;
  cardId: string | null;
  cardFingerprint: string | null;
  createdAt: string;
  amountCents: number;
  note: string | null;
};

let recentPaymentsCache: { ts: number; list: RecentPayment[] } | null = null;
const RECENT_PAYMENTS_TTL_MS = 30 * 60 * 1000;
const RECENT_PAYMENTS_MONTHS = 6;
const RECENT_PAYMENTS_MAX_PAGES = 30; // 3,000 payments

// COMPLETED card payments from the last 6 months, newest first, one paginated
// fetch for the whole account (per-customer payment queries don't exist in
// Square's API). Cached like the customer list.
export async function listRecentPayments(): Promise<RecentPayment[]> {
  const now = Date.now();
  if (recentPaymentsCache && now - recentPaymentsCache.ts < RECENT_PAYMENTS_TTL_MS)
    return recentPaymentsCache.list;

  const begin = new Date(now - RECENT_PAYMENTS_MONTHS * 30 * 24 * 3600 * 1000).toISOString();
  const list: RecentPayment[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < RECENT_PAYMENTS_MAX_PAGES; page++) {
    const url = new URL(`${BASE}/v2/payments`);
    url.searchParams.set("begin_time", begin);
    url.searchParams.set("sort_order", "DESC");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const r = await squareFetch(url.toString());
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Square payments ${r.status}: ${text.slice(0, 300)}`);
    }
    const j = (await r.json()) as { payments?: Array<Record<string, unknown>>; cursor?: string };
    for (const p of j.payments ?? []) {
      if (String(p.status ?? "") !== "COMPLETED") continue;
      const card = (p.card_details as { card?: { id?: string; fingerprint?: string } } | undefined)?.card;
      const amt = p.amount_money as { amount?: number } | undefined;
      list.push({
        id: String(p.id),
        customerId: (p.customer_id as string) ?? null,
        cardId: card?.id ?? null,
        cardFingerprint: card?.fingerprint ?? null,
        createdAt: String(p.created_at ?? ""),
        amountCents: amt?.amount ?? 0,
        note: (p.note as string) ?? null,
      });
    }
    cursor = j.cursor;
    if (!cursor) break;
  }
  recentPaymentsCache = { ts: now, list };
  return list;
}

// ── Charging a card on file ──────────────────────────────────────────────────
// The ONLY Square write in this codebase. Guarded by the idempotency key: the
// same key can never produce two payments, so a retry or double-click is safe.
export type ChargeResult = {
  id: string;
  status: string;
  receiptUrl: string | null;
  amountCents: number;
};

export async function createCardPayment(args: {
  customerId: string;
  cardId: string;
  amountCents: number;
  idempotencyKey: string;
  note: string;
  referenceId?: string;
}): Promise<ChargeResult> {
  // No squareFetch here: POSTs that time out mid-flight must not be blindly
  // retried by a generic wrapper — the idempotency key protects an explicit
  // retry by the caller, and Square treats repeated keys as the same payment.
  const r = await fetch(`${BASE}/v2/payments`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      idempotency_key: args.idempotencyKey,
      source_id: args.cardId,
      customer_id: args.customerId,
      amount_money: { amount: args.amountCents, currency: "USD" },
      autocomplete: true,
      note: args.note.slice(0, 500),
      reference_id: args.referenceId?.slice(0, 40),
    }),
  });
  const j = (await r.json().catch(() => ({}))) as {
    payment?: Record<string, unknown>;
    errors?: Array<{ code?: string; detail?: string; category?: string }>;
  };
  if (!r.ok || !j.payment) {
    const detail = (j.errors ?? []).map((e) => e.detail || e.code).filter(Boolean).join("; ");
    throw new Error(`Square payment failed (${r.status}): ${detail || "unknown error"}`);
  }
  const p = j.payment;
  const amt = p.amount_money as { amount?: number } | undefined;
  return {
    id: String(p.id),
    status: String(p.status ?? ""),
    receiptUrl: (p.receipt_url as string) ?? null,
    amountCents: amt?.amount ?? args.amountCents,
  };
}

// ── Payment links (fallback when a card on file declines) ────────────────────
// A Square-hosted checkout page for a fixed amount: the artist pays with
// whatever card she wants, no card data ever touches our side. Used when
// charging the stored card fails (e.g. GENERIC_DECLINE).

let mainLocationId: string | null = null;

async function getMainLocationId(): Promise<string> {
  if (mainLocationId) return mainLocationId;
  const r = await squareFetch(`${BASE}/v2/locations`);
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Square locations ${r.status}: ${text.slice(0, 300)}`);
  }
  const j = (await r.json()) as { locations?: Array<{ id?: string; status?: string }> };
  const loc = (j.locations ?? []).find((l) => l.status === "ACTIVE") ?? (j.locations ?? [])[0];
  if (!loc?.id) throw new Error("Square: no location found for payment links");
  mainLocationId = loc.id;
  return mainLocationId;
}

export async function createPaymentLink(args: {
  name: string;
  amountCents: number;
  referenceId?: string;
  note?: string;
}): Promise<{ url: string; id: string }> {
  const locationId = await getMainLocationId();
  const r = await fetch(`${BASE}/v2/online-checkout/payment-links`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      idempotency_key: crypto.randomUUID(),
      quick_pay: {
        name: args.name.slice(0, 255),
        price_money: { amount: args.amountCents, currency: "USD" },
        location_id: locationId,
      },
      payment_note: args.note?.slice(0, 500),
      checkout_options: { ask_for_shipping_address: false },
    }),
  });
  const j = (await r.json().catch(() => ({}))) as {
    payment_link?: { id?: string; url?: string; long_url?: string };
    errors?: Array<{ code?: string; detail?: string }>;
  };
  if (!r.ok || !j.payment_link?.url) {
    const detail = (j.errors ?? []).map((e) => e.detail || e.code).filter(Boolean).join("; ");
    throw new Error(`Square payment link failed (${r.status}): ${detail || "unknown error"}`);
  }
  return { url: j.payment_link.url, id: String(j.payment_link.id) };
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
