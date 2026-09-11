import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";

// One feed of everything billing-related that happened from the dashboard:
// every dashboard-subscription charge (paid or failed) and every pause /
// resume sent to Square. Admin only.
export async function GET() {
  const auth = await getAuth();
  if (!auth || auth.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const svc = createServiceClient();
  const [{ data: charges }, { data: actions }] = await Promise.all([
    svc.from("subscription_charges")
      .select("id, owner_key, amount_cents, status, receipt_url, error, charged_by, period_key, charged_at, client_subscriptions(client_label)")
      .order("charged_at", { ascending: false }).limit(300),
    svc.from("square_subscription_actions").select("*").order("created_at", { ascending: false }).limit(300),
  ]);
  type C = { id: string; owner_key: string; amount_cents: number; status: string; receipt_url: string | null; error: string | null;
    charged_by: string | null; period_key: string | null; charged_at: string; client_subscriptions: Array<{ client_label: string | null }> | { client_label: string | null } | null };
  const labelOf = (c: C) => {
    const cs = c.client_subscriptions;
    const l = Array.isArray(cs) ? cs[0]?.client_label : cs?.client_label;
    return l || c.owner_key;
  };
  const feed = [
    ...((charges ?? []) as C[]).map((c) => ({
      at: c.charged_at,
      kind: c.status === "succeeded" ? "charge_paid" : "charge_failed",
      who: labelOf(c),
      amountCents: c.amount_cents,
      detail: c.status === "succeeded" ? `for ${c.period_key ?? ""}`.trim() : (c.error ?? "failed"),
      actor: c.charged_by === "cron" ? "schedule" : (c.charged_by?.split("@")[0] ?? "—"),
      link: c.receipt_url,
    })),
    ...((actions ?? []) as Array<{ id: string; customer_name: string | null; action: string; status: string; detail: string | null; error: string | null; actor: string | null; created_at: string }>).map((a) => ({
      at: a.created_at,
      kind: a.status === "succeeded" ? `square_${a.action}` : "square_failed",
      who: a.customer_name || "Square subscription",
      amountCents: null as number | null,
      detail: a.status === "succeeded" ? (a.detail ?? a.action) : `${a.action} failed — ${a.error ?? ""}`,
      actor: a.actor?.split("@")[0] ?? "—",
      link: null as string | null,
    })),
  ].sort((x, y) => y.at.localeCompare(x.at));
  return NextResponse.json({ feed });
}
