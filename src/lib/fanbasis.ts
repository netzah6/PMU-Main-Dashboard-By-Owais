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
