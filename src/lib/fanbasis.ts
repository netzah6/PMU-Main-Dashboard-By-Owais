// Fanbasis (payments) — deposit-product creation for new-client onboarding.
// Docs: https://apidocs.fan/ — auth via x-api-key; products are created
// through checkout sessions (product.title + amount_cents + type).

const BASE = "https://www.fanbasis.com/public-api";

function headers(): Record<string, string> {
  const key = process.env.FANBASIS_API_KEY;
  if (!key) throw new Error("FANBASIS_API_KEY not set");
  return { "x-api-key": key, "Content-Type": "application/json", Accept: "application/json" };
}

// "$45" / "45$" / "45.00" → 4500 cents
export function parseAmountCents(raw: string): number | null {
  const m = String(raw).replace(/[^0-9.]/g, "");
  if (!m) return null;
  const dollars = Number(m);
  if (!Number.isFinite(dollars) || dollars <= 0) return null;
  return Math.round(dollars * 100);
}

export type FanbasisProduct = {
  productId: string | null;
  checkoutUrl: string | null;
  raw: Record<string, unknown>;
};

// Create a reusable one-time deposit product ("FULLNAME + BUSINESS NAME",
// per the team's naming convention).
export async function createDepositProduct(title: string, amountCents: number): Promise<FanbasisProduct> {
  const r = await fetch(`${BASE}/checkout-sessions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      product: { title },
      amount_cents: amountCents,
      type: "onetime_reusable",
    }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Fanbasis checkout-sessions HTTP ${r.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text) as Record<string, unknown>;

  // Field names are defensive — extract the product id and checkout link
  // from whichever shape the API returns.
  const dig = (o: unknown, ...keys: string[]): string | null => {
    for (const k of keys) {
      const v = (o as Record<string, unknown> | null)?.[k];
      if (typeof v === "string" && v) return v;
      if (typeof v === "number") return String(v);
    }
    return null;
  };
  const product = (j.product ?? j.data ?? null) as Record<string, unknown> | null;
  const productId =
    dig(j, "product_id", "productId") ??
    dig(product, "id", "product_id", "_id") ??
    dig(j, "id");
  const checkoutUrl = dig(j, "checkout_url", "url", "payment_link", "link") ?? dig(product, "checkout_url", "url");
  return { productId, checkoutUrl, raw: j };
}

// ── Refunds ───────────────────────────────────────────────────────────────
// Refund flow: a deposit's `Product ID` is its checkout session → list that
// session's transactions → match the buyer's email → refund that transaction.
// Docs: GET /checkout-sessions/{id}/transactions, POST /refunds.

type FanTransaction = { id: string; email: string; raw: Record<string, unknown> };

// List the transactions (paid checkouts) for a checkout session / product.
export async function listCheckoutTransactions(checkoutSessionId: string): Promise<FanTransaction[]> {
  const out: FanTransaction[] = [];
  for (let page = 1; page <= 10; page++) {
    const r = await fetch(`${BASE}/checkout-sessions/${encodeURIComponent(checkoutSessionId)}/transactions?page=${page}&per_page=100`, {
      headers: headers(),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Fanbasis transactions HTTP ${r.status}: ${text.slice(0, 300)}`);
    const j = JSON.parse(text) as Record<string, unknown>;
    const container = (j.data ?? j) as Record<string, unknown>;
    const list = (container.transactions ?? j.transactions ?? []) as Array<Record<string, unknown>>;
    for (const t of list) {
      const fan = (t.fan ?? {}) as Record<string, unknown>;
      const id = String(t.id ?? t.transaction_id ?? t._id ?? "");
      const email = String(fan.email ?? t.email ?? "").trim().toLowerCase();
      if (id) out.push({ id, email, raw: t });
    }
    if (list.length < 100) break;
  }
  return out;
}

// Refund a single transaction by its id. Endpoint CONFIRMED via live probes
// (2026-07-13): POST https://www.fanbasis.com/api/seller/v1/transactions/{id}/refund
// — a GET there returns 405 "Supported methods: POST", while every /public-api
// refund path 404s. The seller-v1 API rejects x-api-key with 401 "Please check
// user token or client credentials" — OAuth-style Bearer auth. Try the API key
// as a Bearer token (alone, then combined with x-api-key, then x-api-key only):
// a 401 processes nothing, so falling through is safe and money moves at most
// once. Minimal body (reason only) = full-refund default; a 422 names any
// missing fields without refunding.
export async function refundTransaction(
  transactionId: string,
  opts: { reason?: string; amountCents?: number } = {}
): Promise<Record<string, unknown>> {
  const key = process.env.FANBASIS_API_KEY;
  if (!key) throw new Error("FANBASIS_API_KEY not set");
  const path = `https://www.fanbasis.com/api/seller/v1/transactions/${encodeURIComponent(transactionId)}/refund`;
  const body: Record<string, unknown> = {};
  if (opts.reason) body.reason = opts.reason;
  const base = { "Content-Type": "application/json", Accept: "application/json" };
  const authVariants: Array<{ name: string; headers: Record<string, string> }> = [
    { name: "bearer", headers: { ...base, Authorization: `Bearer ${key}` } },
    { name: "bearer+x-api-key", headers: { ...base, Authorization: `Bearer ${key}`, "x-api-key": key } },
    { name: "x-api-key", headers: { ...base, "x-api-key": key } },
  ];
  let last = "";
  for (const v of authVariants) {
    const r = await fetch(path, { method: "POST", headers: v.headers, body: JSON.stringify(body) });
    const text = await r.text();
    if (r.status === 401) { last = text.slice(0, 200); continue; } // auth rejected — nothing processed
    if (!r.ok) throw new Error(`Fanbasis refund HTTP ${r.status} @ POST /api/seller/v1/transactions/{id}/refund [auth=${v.name}]: ${text.slice(0, 300)}`);
    const j = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    return { ...j, _endpoint: path, _auth: v.name };
  }
  throw new Error(`Fanbasis refund: seller-v1 rejected every auth variant (bearer, bearer+x-api-key, x-api-key) with 401 — the account may need seller API credentials from Fanbasis. Last response: ${last}`);
}

// Read-only diagnostic for the refund flow — NO money moves. Given a deposit's
// product id + buyer email, returns the matched transaction's RAW shape (so we
// can see the real id fields), whether its id resolves at the top-level
// transactions endpoint, and GET-probe statuses for candidate refund routes
// (404 = route absent; anything else = route likely exists). Used to determine
// the correct refund endpoint without live-testing refunds.
export async function debugRefundLookup(productId: string, email: string): Promise<Record<string, unknown>> {
  const SELLER = "https://www.fanbasis.com/api/seller/v1";
  const want = String(email ?? "").trim().toLowerCase();
  const txns = await listCheckoutTransactions(productId);
  const match = (want && txns.find((t) => t.email === want)) || (txns.length === 1 ? txns[0] : null);
  const out: Record<string, unknown> = {
    productId, want,
    foundCount: txns.length,
    found: txns.map((t) => ({ id: t.id, email: t.email })),
    matchedId: match?.id ?? null,
    matchedRawKeys: match ? Object.keys(match.raw) : null,
    matchedRaw: match?.raw ?? null,
  };
  if (!match) return out;
  const id = encodeURIComponent(match.id);
  const probe = async (url: string) => {
    try { const r = await fetch(url, { headers: headers() }); return { status: r.status, body: (await r.text()).slice(0, 200) }; }
    catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  };
  out.probes = {
    [`GET ${BASE}/transactions/${match.id}`]: await probe(`${BASE}/transactions/${id}`),
    [`GET ${BASE}/transactions/${match.id}/refund`]: await probe(`${BASE}/transactions/${id}/refund`),
    [`GET ${BASE}/refunds`]: await probe(`${BASE}/refunds`),
    [`GET ${SELLER}/transactions/${match.id}/refund`]: await probe(`${SELLER}/transactions/${id}/refund`),
    [`GET ${SELLER}/refunds`]: await probe(`${SELLER}/refunds`),
    [`GET ${SELLER}/transactions/${match.id}`]: await probe(`${SELLER}/transactions/${id}`),
  };

  // Auth probes for the seller-v1 API (which 401s on x-api-key): hit a
  // documented read-only seller route with each auth style. 401 = credentials
  // rejected; 403/404/422 = credentials ACCEPTED (request reached the route).
  // GET on the refund route is method-blocked (405) before auth, so use the
  // documented subscriptions/upgrades GET with a bogus id — read-only, no side
  // effects, and a non-401 status proves which header form seller-v1 accepts.
  const key = process.env.FANBASIS_API_KEY ?? "";
  const authProbe = async (hdrs: Record<string, string>) => {
    try {
      const r = await fetch(`${SELLER}/subscriptions/0/upgrades`, { headers: { Accept: "application/json", ...hdrs } });
      return { status: r.status, body: (await r.text()).slice(0, 200) };
    } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  };
  out.sellerAuthProbes = {
    "x-api-key": await authProbe({ "x-api-key": key }),
    "bearer": await authProbe({ Authorization: `Bearer ${key}` }),
    "bearer+x-api-key": await authProbe({ Authorization: `Bearer ${key}`, "x-api-key": key }),
    "none": await authProbe({}),
  };
  return out;
}

export type RefundResult = {
  ok: boolean;
  transactionId?: string;
  result?: Record<string, unknown>;
  error?: string;
  // On failure: what we looked up, so the stored record is diagnosable.
  diagnostic?: Record<string, unknown>;
};

// Resolve a deposit (product id + buyer email) to its transaction, then refund.
export async function refundDepositByProduct(
  productId: string,
  email: string,
  opts: { reason?: string; amountCents?: number } = {}
): Promise<RefundResult> {
  try {
    if (!productId) return { ok: false, error: "deposit has no Fanbasis Product ID" };
    const want = String(email ?? "").trim().toLowerCase();
    const txns = await listCheckoutTransactions(productId);
    // Prefer an exact email match; fall back to the only transaction if unambiguous.
    const match = (want && txns.find((t) => t.email === want)) || (txns.length === 1 ? txns[0] : null);
    const diagnostic = { productId, want, amountCents: opts.amountCents ?? null, found: txns.map((t) => ({ id: t.id, email: t.email })) };
    if (!match) {
      return { ok: false, diagnostic, error: want ? `no transaction found for ${want} on product ${productId} (${txns.length} on file)` : "no email to match the transaction" };
    }
    try {
      const result = await refundTransaction(match.id, { reason: opts.reason, amountCents: opts.amountCents });
      return { ok: true, transactionId: match.id, result };
    } catch (e) {
      // Keep the attempted transaction id + what we found, so a failed retry is diagnosable.
      return { ok: false, transactionId: match.id, diagnostic, error: e instanceof Error ? e.message : "refund failed" };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "refund failed" };
  }
}
