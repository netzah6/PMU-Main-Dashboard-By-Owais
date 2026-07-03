import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { squareConfigured, listSubscriptions, getCustomers, getPlans } from "@/lib/square";

export const maxDuration = 60;

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
    const customerIds = Array.from(new Set(subs.map((s) => s.customerId).filter(Boolean))) as string[];
    const planIds = Array.from(new Set(subs.map((s) => s.planVariationId).filter(Boolean))) as string[];
    const [customers, plans] = await Promise.all([getCustomers(customerIds), getPlans(planIds)]);

    const rows = subs.map((s) => {
      const plan = s.planVariationId ? plans.get(s.planVariationId) : undefined;
      const customer = s.customerId ? customers.get(s.customerId) : undefined;
      return {
        id: s.id,
        status: s.status,
        customerName: customer?.name ?? s.customerId ?? "—",
        customerEmail: customer?.email ?? null,
        planName: plan?.name ?? "Subscription",
        cadence: plan?.cadence ?? "",
        amountCents: s.priceOverrideCents ?? plan?.priceCents ?? null,
        currency: s.currency,
        startDate: s.startDate,
        chargedThroughDate: s.chargedThroughDate,
        canceledDate: s.canceledDate,
        monthlyBillingAnchor: s.monthlyBillingAnchor,
      };
    });

    return NextResponse.json({ subscriptions: rows });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Square request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
