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

// Refund a single transaction by its id (full refund by default).
export async function refundTransaction(transactionId: string, reason?: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${BASE}/refunds`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ transaction_id: transactionId, ...(reason ? { reason } : {}) }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Fanbasis refund HTTP ${r.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

export type RefundResult = { ok: boolean; transactionId?: string; result?: Record<string, unknown>; error?: string };

// Resolve a deposit (product id + buyer email) to its transaction, then refund.
export async function refundDepositByProduct(productId: string, email: string, reason?: string): Promise<RefundResult> {
  try {
    if (!productId) return { ok: false, error: "deposit has no Fanbasis Product ID" };
    const want = String(email ?? "").trim().toLowerCase();
    const txns = await listCheckoutTransactions(productId);
    // Prefer an exact email match; fall back to the only transaction if unambiguous.
    const match = (want && txns.find((t) => t.email === want)) || (txns.length === 1 ? txns[0] : null);
    if (!match) {
      return { ok: false, error: want ? `no transaction found for ${want} on product ${productId} (${txns.length} on file)` : "no email to match the transaction" };
    }
    const result = await refundTransaction(match.id, reason);
    return { ok: true, transactionId: match.id, result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "refund failed" };
  }
}
