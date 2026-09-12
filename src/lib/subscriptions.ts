import { createHash } from "crypto";
import { createServiceClient } from "@/lib/supabase/server";
import { createCardPayment, listCards, searchCustomersByEmail, searchCustomersByPhone } from "@/lib/square";
import { normalizeOwnerKey } from "@/lib/normalizers";

// Recurring billing run from the dashboard rather than Square Subscriptions.
//
// Why not Square: pausing or resuming a Square subscription emails the client
// ("your subscription is paused"), which reads as "my service stopped" to an
// artist whose campaign is still running. A plain card payment sends no email —
// createCardPayment deliberately omits buyer_email_address — so billing from
// here is silent to the client while still producing a Square receipt for us.
//
// SAFETY, in three layers, because this moves real money:
//   1. A subscription is created as 'draft' and charges nothing until an admin
//      activates it.
//   2. Nothing charges at all while the global autocharge switch is off, and
//      it ships off.
//   3. One success per billing period is enforced by a unique index, so a
//      retry, a double-click or an overlapping cron cannot charge twice.

export type Subscription = {
  id: string;
  owner_key: string;
  client_label: string | null;
  amount_cents: number;
  cadence: "monthly" | "once";
  charge_day: number | null;
  next_charge_on: string;
  status: "draft" | "active" | "paused" | "ended";
  note: string | null;
  square_customer_id: string | null;
  square_card_id: string | null;
  activated_at?: string | null;
  activated_by?: string | null;
  created_by?: string | null;
};

type Svc = ReturnType<typeof createServiceClient>;

/** Is the scheduled charge run allowed to move money at all? Ships off. */
export async function autochargeEnabled(svc: Svc): Promise<boolean> {
  const { data } = await svc.from("app_settings").select("value").eq("key", "subscription_autocharge").maybeSingle();
  return (data?.value as { enabled?: boolean } | null)?.enabled === true;
}

/** The billing period a charge belongs to — the guard against double charges. */
export function periodKey(sub: Subscription, on: string): string {
  return sub.cadence === "monthly" ? on.slice(0, 7) : on;
}

/** Next due date after charging for `on`. "once" subscriptions do not recur. */
export function advance(sub: Subscription, on: string): string | null {
  if (sub.cadence === "once") return null;
  const d = new Date(`${on}T12:00:00Z`);
  const day = sub.charge_day ?? d.getUTCDate();
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, Math.min(day, 28), 12));
  return next.toISOString().slice(0, 10);
}

export type CardTarget = { customerId: string; cardId: string; label: string };

/** The Square customer for a client: the ppa_card_prefs pin's customer if one
 *  exists, otherwise found by the email or phone on their Clients Master row.
 *  Never guesses across clients — two matches is a refusal. */
export async function resolveCustomer(svc: Svc, ownerKey: string): Promise<{ customerId: string; pinnedCardId: string | null } | { error: string }> {
  const { data: pin } = await svc
    .from("ppa_card_prefs").select("customer_id, card_id").eq("owner_key", ownerKey).maybeSingle();
  if (pin?.customer_id) return { customerId: pin.customer_id as string, pinnedCardId: (pin.card_id as string) ?? null };

  const { data: rows } = await svc.from("clients_master").select("data");
  const row = (rows ?? []).find(
    (r) => normalizeOwnerKey((r as { data: Record<string, unknown> }).data?.["Owner Full Name"]) === ownerKey
  ) as { data: Record<string, string> } | undefined;
  if (!row) return { error: "No Clients Master row for this client" };

  const email = String(row.data["Email"] ?? "").trim();
  const phone = String(row.data["Phone"] ?? "").trim();
  let customers = email ? await searchCustomersByEmail(email) : [];
  if (!customers.length && phone) customers = await searchCustomersByPhone(phone);
  if (!customers.length) return { error: "No Square customer found by email or phone" };
  if (customers.length > 1) return { error: `${customers.length} Square customers match — pin the right card first` };
  return { customerId: customers[0].id, pinnedCardId: null };
}

/**
 * The card a charge will use when the subscription has no card of its own:
 * the ppa_card_prefs pin if there is one, else the customer's first enabled
 * card. Callers that want the admin to CHOOSE should list cards instead.
 */
export async function resolveCard(svc: Svc, ownerKey: string): Promise<CardTarget | { error: string }> {
  const cust = await resolveCustomer(svc, ownerKey);
  if ("error" in cust) return cust;
  if (cust.pinnedCardId) return { customerId: cust.customerId, cardId: cust.pinnedCardId, label: "pinned card" };
  const cards = (await listCards(cust.customerId, false)).filter((c) => c.enabled !== false);
  if (!cards.length) return { error: "Square customer has no usable card on file" };
  const c = cards[0];
  return { customerId: cust.customerId, cardId: c.id, label: `${c.brand || "card"} ••${c.last4}` };
}

export type ChargeOutcome =
  | { ok: true; paymentId: string; receiptUrl: string | null; amountCents: number; card: string }
  | { ok: false; error: string };

/**
 * Charge one subscription for the period covering `on`. Refuses anything that
 * is not active. Writes a ledger row either way, and only advances the due date
 * when money actually moved.
 */
export async function chargeSubscription(
  svc: Svc, sub: Subscription, on: string, chargedBy: string
): Promise<ChargeOutcome> {
  if (sub.status !== "active") return { ok: false, error: `Subscription is ${sub.status}, not active` };

  const period = periodKey(sub, on);
  const { data: already } = await svc
    .from("subscription_charges").select("id")
    .eq("subscription_id", sub.id).eq("period_key", period).eq("status", "succeeded").maybeSingle();
  if (already) return { ok: false, error: `Already charged for ${period}` };

  const target = sub.square_customer_id && sub.square_card_id
    ? { customerId: sub.square_customer_id, cardId: sub.square_card_id, label: "pinned card" }
    : await resolveCard(svc, sub.owner_key);
  if ("error" in target) {
    await svc.from("subscription_charges").insert({
      subscription_id: sub.id, owner_key: sub.owner_key, amount_cents: sub.amount_cents,
      status: "failed", error: target.error, charged_by: chargedBy, period_key: period,
    });
    return { ok: false, error: target.error };
  }

  // Same subscription + same period => same key, so Square returns the existing
  // payment instead of creating a second one.
  const idempotencyKey = createHash("sha256").update(`sub:${sub.id}:${period}`).digest("hex").slice(0, 45);
  try {
    const p = await createCardPayment({
      customerId: target.customerId,
      cardId: target.cardId,
      amountCents: sub.amount_cents,
      idempotencyKey,
      note: `${sub.client_label || sub.owner_key} — ${period}${sub.note ? ` · ${sub.note}` : ""}`,
      referenceId: sub.owner_key,
    });
    await svc.from("subscription_charges").insert({
      subscription_id: sub.id, owner_key: sub.owner_key, amount_cents: p.amountCents,
      status: "succeeded", square_payment_id: p.id, receipt_url: p.receiptUrl,
      charged_by: chargedBy, period_key: period,
    });
    const next = advance(sub, on);
    await svc.from("client_subscriptions").update({
      next_charge_on: next ?? sub.next_charge_on,
      status: next ? sub.status : "ended",
      updated_at: new Date().toISOString(),
    }).eq("id", sub.id);
    return { ok: true, paymentId: p.id, receiptUrl: p.receiptUrl, amountCents: p.amountCents, card: target.label };
  } catch (e) {
    const error = e instanceof Error ? e.message : "Charge failed";
    await svc.from("subscription_charges").insert({
      subscription_id: sub.id, owner_key: sub.owner_key, amount_cents: sub.amount_cents,
      status: "failed", error, charged_by: chargedBy, period_key: period,
    });
    return { ok: false, error };
  }
}
