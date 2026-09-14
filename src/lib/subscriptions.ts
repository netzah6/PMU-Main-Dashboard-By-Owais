import { createHash } from "crypto";
import { createServiceClient } from "@/lib/supabase/server";
import { createCardPayment, listCards, listAllCustomers, listRecentPayments, searchCustomersByEmail, searchCustomersByPhone, type SquareCard, type SquareCustomer } from "@/lib/square";
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
  // Failed-charge retries: 0 = no failure pending; 1..3 = which retry is
  // scheduled next; a 4th failure pauses the subscription (see RETRY_DAYS).
  retry_attempt?: number | null;
  retry_period?: string | null; // the period the retries are still trying to collect
  pause_reason?: string | null;
};

/* After a failed charge, try again after this many days: +1, then +3, then
   +4 (user, 2026-09-14). A fourth failure pauses the subscription with a
   reason, so it shows up on the Subs tab instead of retrying forever. */
export const RETRY_DAYS = [1, 3, 4] as const;

function addDays(on: string, n: number): string {
  const d = new Date(`${on}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* Where a failed subscription goes next: the next retry date, or paused
   once the retries are used up. Returns the ledger note to log with it. */
async function scheduleRetry(svc: Svc, sub: Subscription, on: string, error: string): Promise<string> {
  const attempt = sub.retry_attempt ?? 0;
  const now = new Date().toISOString();
  if (attempt < RETRY_DAYS.length) {
    const next = addDays(on, RETRY_DAYS[attempt]);
    // A retry that slips into next month still collects THIS period.
    const retry_period = sub.retry_period ?? periodKey(sub, on);
    await svc.from("client_subscriptions").update({ next_charge_on: next, retry_attempt: attempt + 1, retry_period, updated_at: now }).eq("id", sub.id);
    return `retry ${attempt + 1} of ${RETRY_DAYS.length} on ${next}`;
  }
  await svc.from("client_subscriptions").update({
    status: "paused", retry_attempt: 0, retry_period: null, updated_at: now,
    pause_reason: `Card failed ${RETRY_DAYS.length + 1} times (last: ${error.slice(0, 120)}) — paused ${on}; fix the card, then resume`,
  }).eq("id", sub.id);
  return "retries exhausted — subscription paused";
}

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

  /* Square keeps a separate customer record per checkout, so one artist is
     often two or three records — and the card lives on only one of them.
     Casandra Brown (2026-09-14): Clients Master has sabbybeautyacademy@…,
     her card sits on the record under sabbybeauty1@… (the one her old Square
     subscription bills), so the email match found a card-less twin and the
     picker said "no cards on file". Gather every plausible record — master
     email, master phone, the email on her Square subscription, and any record
     whose name matches — then let the cards decide which one is hers. */
  const email = String(row.data["Email"] ?? "").trim();
  const phone = String(row.data["Phone"] ?? "").trim();
  const seen = new Map<string, SquareCustomer>();
  const add = (list: SquareCustomer[]) => { for (const c of list) if (!seen.has(c.id)) seen.set(c.id, c); };
  if (email) add(await searchCustomersByEmail(email));
  if (phone) add(await searchCustomersByPhone(phone));
  for (const e of await subscriptionEmailsFor(svc, ownerKey)) {
    if (e && e.toLowerCase() !== email.toLowerCase()) add(await searchCustomersByEmail(e));
  }
  try {
    const { customers } = await listAllCustomers();
    add(customers.filter((c) => normalizeOwnerKey(c.name) === ownerKey));
  } catch { /* the scan is a bonus — the direct lookups above still stand */ }

  const candidates = [...seen.values()];
  if (!candidates.length) return { error: "No Square customer found by email, phone or name" };
  if (candidates.length === 1) return { customerId: candidates[0].id, pinnedCardId: null };

  // Several records: the one holding a usable card is the real one.
  const withCards: SquareCustomer[] = [];
  for (const c of candidates) {
    const cards = (await listCards(c.id, false)).filter((k) => k.enabled !== false);
    if (cards.length) withCards.push(c);
  }
  const describe = (l: SquareCustomer[]) => l.map((c) => c.email || c.name).join(", ");
  if (withCards.length === 1) return { customerId: withCards[0].id, pinnedCardId: null };
  if (withCards.length === 0)
    return { error: `${candidates.length} Square customers match (${describe(candidates)}) and none has a card on file` };
  return { error: `${withCards.length} Square customers with cards match (${describe(withCards)}) — pin the right card on PPS Billing first` };
}

/* Emails Square itself has for this artist, taken from the stored Square
   Subscriptions snapshot (one row per subscription, with the customer's
   name + email). A record the artist was billed on before is the best lead
   to the one carrying her card. */
async function subscriptionEmailsFor(svc: Svc, ownerKey: string): Promise<string[]> {
  const { data } = await svc.from("square_subscriptions_snapshot").select("payload").eq("id", 1).maybeSingle();
  const subs = ((data?.payload as { subscriptions?: Array<{ customerName?: string; customerEmail?: string | null }> } | null)?.subscriptions) ?? [];
  const out = new Set<string>();
  for (const s of subs) {
    if (s.customerEmail && normalizeOwnerKey(s.customerName) === ownerKey) out.add(s.customerEmail.trim());
  }
  return [...out];
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
  const last = await lastUsedCard(cust.customerId, cards);
  const c = last ?? cards[0];
  return { customerId: cust.customerId, cardId: c.id, label: `${c.brand || "card"} ••${c.last4}${last ? " (last used)" : ""}` };
}

/**
 * The card this customer most recently paid with, if it is still on file —
 * the sensible default for a new subscription (user, 2026-09-14). Square has
 * no "default card", and its card list only orders by creation, so the last
 * COMPLETED payment is the signal: matched by card id, or by fingerprint when
 * the payment was made with a re-saved copy of the same physical card.
 */
export async function lastUsedCard(customerId: string, cards: SquareCard[]): Promise<SquareCard | null> {
  if (!cards.length) return null;
  try {
    const payments = await listRecentPayments(); // newest first
    for (const p of payments) {
      if (p.customerId !== customerId) continue;
      const hit = cards.find((c) => (p.cardId && c.id === p.cardId) || (p.cardFingerprint && c.fingerprint === p.cardFingerprint));
      if (hit) return hit;
    }
  } catch { /* payments are a nicety — fall back to newest card */ }
  return null;
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

  // Retries keep collecting the period the first attempt was for, even
  // when the retry date has crossed into the next month.
  const period = (sub.retry_attempt ?? 0) > 0 && sub.retry_period ? sub.retry_period : periodKey(sub, on);
  const { data: already } = await svc
    .from("subscription_charges").select("id")
    .eq("subscription_id", sub.id).eq("period_key", period).eq("status", "succeeded").maybeSingle();
  if (already) return { ok: false, error: `Already charged for ${period}` };

  const target = sub.square_customer_id && sub.square_card_id
    ? { customerId: sub.square_customer_id, cardId: sub.square_card_id, label: "pinned card" }
    : await resolveCard(svc, sub.owner_key);
  if ("error" in target) {
    const plan = await scheduleRetry(svc, sub, on, target.error);
    await svc.from("subscription_charges").insert({
      subscription_id: sub.id, owner_key: sub.owner_key, amount_cents: sub.amount_cents,
      status: "failed", error: `${target.error} · ${plan}`, charged_by: chargedBy, period_key: period,
    });
    return { ok: false, error: `${target.error} · ${plan}` };
  }

  // Same subscription + same period => same key, so Square returns the existing
  // payment instead of creating a second one.
  // …but a RETRY of a declined charge must be a new request — Square would
  // replay the decline for a reused key — so the attempt number is part of it.
  const idempotencyKey = createHash("sha256").update(`sub:${sub.id}:${period}:${sub.retry_attempt ?? 0}`).digest("hex").slice(0, 45);
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
      retry_attempt: 0, retry_period: null, pause_reason: null,
      updated_at: new Date().toISOString(),
    }).eq("id", sub.id);
    return { ok: true, paymentId: p.id, receiptUrl: p.receiptUrl, amountCents: p.amountCents, card: target.label };
  } catch (e) {
    const error = e instanceof Error ? e.message : "Charge failed";
    const plan = await scheduleRetry(svc, sub, on, error);
    await svc.from("subscription_charges").insert({
      subscription_id: sub.id, owner_key: sub.owner_key, amount_cents: sub.amount_cents,
      status: "failed", error: `${error} · ${plan}`, charged_by: chargedBy, period_key: period,
    });
    return { ok: false, error: `${error} · ${plan}` };
  }
}
