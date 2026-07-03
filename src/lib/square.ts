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
};

// All subscriptions in the account (every status), paginated.
export async function listSubscriptions(): Promise<SquareSubscription[]> {
  const out: SquareSubscription[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const body: Record<string, unknown> = { limit: 200 };
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
      });
    }
    cursor = j.cursor;
    if (!cursor) break;
  }
  return out;
}

export type SquareCustomer = { id: string; name: string; email: string | null };

export async function getCustomers(ids: string[]): Promise<Map<string, SquareCustomer>> {
  const map = new Map<string, SquareCustomer>();
  // Small accounts: fetch individually with modest concurrency.
  const chunk = 8;
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk);
    await Promise.all(
      slice.map(async (id) => {
        try {
          const r = await fetch(`${BASE}/v2/customers/${id}`, { headers: headers() });
          if (!r.ok) return;
          const j = (await r.json()) as { customer?: Record<string, unknown> };
          const c = j.customer;
          if (!c) return;
          const name =
            `${c.given_name ?? ""} ${c.family_name ?? ""}`.trim() ||
            String(c.company_name ?? "").trim() ||
            String(c.email_address ?? "").trim() ||
            id;
          map.set(id, { id, name, email: (c.email_address as string) ?? null });
        } catch {
          /* best-effort; name falls back to id */
        }
      })
    );
  }
  return map;
}

export type SquarePlan = { id: string; name: string; cadence: string; priceCents: number | null };

export async function getPlans(ids: string[]): Promise<Map<string, SquarePlan>> {
  const map = new Map<string, SquarePlan>();
  for (const id of ids) {
    try {
      const r = await fetch(`${BASE}/v2/catalog/object/${id}`, { headers: headers() });
      if (!r.ok) continue;
      const j = (await r.json()) as { object?: Record<string, unknown> };
      const obj = j.object;
      if (!obj) continue;
      const data = (obj.subscription_plan_variation_data ?? obj.subscription_plan_data) as
        | { name?: string; phases?: Array<Record<string, unknown>> }
        | undefined;
      const phase = data?.phases?.[0] as
        | { cadence?: string; pricing?: { price_money?: { amount?: number } }; recurring_price_money?: { amount?: number } }
        | undefined;
      map.set(id, {
        id,
        name: data?.name ?? "Subscription",
        cadence: phase?.cadence ?? "",
        priceCents: phase?.pricing?.price_money?.amount ?? phase?.recurring_price_money?.amount ?? null,
      });
    } catch {
      /* best-effort */
    }
  }
  return map;
}
