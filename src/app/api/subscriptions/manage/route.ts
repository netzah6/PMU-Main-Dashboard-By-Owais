import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { autochargeEnabled, advance, findManualPayment, priceForPeriod, type Subscription } from "@/lib/subscriptions";
import { nextAfterPaid, owedPeriod, paymentSince } from "@/lib/subscription-dates";

export const maxDuration = 60;

// Dashboard-run subscriptions: list, create, edit, activate, pause, resume,
// end. Admin only — nothing here is exposed to coaches.
//
// A new subscription is always created as 'draft'. Activating it is a separate,
// deliberate action, so creating one can never start billing by itself.

async function admin() {
  const auth = await getAuth();
  if (!auth || auth.role !== "admin") return null;
  return auth;
}

export async function GET() {
  const auth = await admin();
  if (!auth) return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const svc = createServiceClient();
  // One-month prices from last month on — a retry can still be collecting
  // last month's (older ones are history).
  const d = new Date();
  const thisMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const [{ data: subs }, { data: charges }, enabled, { data: periodAmounts }] = await Promise.all([
    svc.from("client_subscriptions").select("*").order("created_at", { ascending: false }),
    svc.from("subscription_charges").select("*").order("charged_at", { ascending: false }).limit(400),
    autochargeEnabled(svc),
    svc.from("subscription_period_amounts").select("subscription_id, period_key, amount_cents, reason, created_by")
      .gte("period_key", thisMonth).order("period_key", { ascending: true }),
  ]);
  /* Which bill "Mark paid" would settle, worked out from each subscription's
     WHOLE ledger — the 400-row list above can cut an old subscription short,
     and the page must show the same month the server will mark. */
  const ledger: Array<{ subscription_id: string; status: string; period_key: string | null; charged_at: string }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await svc.from("subscription_charges")
      .select("subscription_id, status, period_key, charged_at").order("charged_at").range(from, from + 999);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    ledger.push(...((data ?? []) as typeof ledger));
    if (!data || data.length < 1000) break;
  }
  const owed: Record<string, string> = {};
  for (const s of (subs ?? []) as Subscription[]) {
    if (s.status === "active" || s.status === "paused") owed[s.id] = owedPeriod(s, ledger.filter((c) => c.subscription_id === s.id));
  }
  return NextResponse.json({ subscriptions: subs ?? [], charges: charges ?? [], autocharge: enabled, periodAmounts: periodAmounts ?? [], owed });
}

export async function POST(req: NextRequest) {
  const auth = await admin();
  if (!auth) return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const svc = createServiceClient();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action ?? "");
  const now = new Date().toISOString();

  if (action === "autocharge") {
    const enabled = body.enabled === true;
    const { error } = await svc.from("app_settings").upsert({
      key: "subscription_autocharge", value: { enabled }, updated_by: auth.email, updated_at: now,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, autocharge: enabled });
  }

  if (action === "create") {
    const ownerKey = String(body.ownerKey ?? "").trim().toLowerCase();
    const amount = Math.round(Number(body.amount) * 100);
    const cadence = body.cadence === "once" ? "once" : "monthly";
    const nextOn = String(body.nextChargeOn ?? "").slice(0, 10);
    if (!ownerKey) return NextResponse.json({ error: "Pick a client" }, { status: 400 });
    if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ error: "Enter an amount above zero" }, { status: 400 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nextOn)) return NextResponse.json({ error: "Pick the first charge date" }, { status: 400 });
    const day = Number(nextOn.slice(8, 10));
    if (cadence === "monthly" && day > 28) {
      return NextResponse.json({ error: "Pick a day from 1–28 so every month has that date" }, { status: 400 });
    }
    const { data, error } = await svc.from("client_subscriptions").insert({
      owner_key: ownerKey,
      client_label: String(body.clientLabel ?? "") || null,
      amount_cents: amount,
      cadence,
      charge_day: cadence === "monthly" ? day : null,
      next_charge_on: nextOn,
      status: "draft",              // never bills until an admin activates it
      note: String(body.note ?? "") || null,
      created_by: auth.email,
    }).select().single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, subscription: data });
  }

  const id = String(body.id ?? "");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { data: cur } = await svc.from("client_subscriptions").select("*").eq("id", id).maybeSingle();
  if (!cur) return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
  const sub = cur as Subscription;

  if (action === "activate" || action === "resume") {
    // Resuming after a card failure starts the retry count fresh.
    const patch: Record<string, unknown> = { status: "active", retry_attempt: 0, retry_period: null, pause_reason: null, updated_at: now };
    if (!sub.activated_at) { patch.activated_by = auth.email; patch.activated_at = now; }
    // A due date already in the past would charge the moment it is switched on.
    const today = new Date().toISOString().slice(0, 10);
    if (sub.next_charge_on < today) patch.next_charge_on = advance({ ...sub, next_charge_on: today }, today) ?? today;
    const { error } = await svc.from("client_subscriptions").update(patch).eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  if (action === "pause" || action === "end") {
    const { error } = await svc.from("client_subscriptions")
      .update({ status: action === "pause" ? "paused" : "ended", updated_at: now }).eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  // Which card on file this subscription charges. Empty ids clear the choice,
  // and the charge falls back to the PPS pin / first enabled card again.
  if (action === "set_card") {
    const customerId = String(body.customerId ?? "").trim();
    const cardId = String(body.cardId ?? "").trim();
    const label = String(body.cardLabel ?? "").trim().slice(0, 40) || null;
    const patch = customerId && cardId
      ? { square_customer_id: customerId, square_card_id: cardId, square_card_label: label, updated_at: now }
      : { square_customer_id: null, square_card_id: null, square_card_label: null, updated_at: now };
    const { error } = await svc.from("client_subscriptions").update(patch).eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  if (action === "update") {
    const patch: Record<string, unknown> = { updated_at: now };
    if (body.amount != null) {
      const amount = Math.round(Number(body.amount) * 100);
      if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ error: "Bad amount" }, { status: 400 });
      patch.amount_cents = amount;
    }
    if (typeof body.nextChargeOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.nextChargeOn)) {
      patch.next_charge_on = body.nextChargeOn;
      if (sub.cadence === "monthly") patch.charge_day = Number(body.nextChargeOn.slice(8, 10));
    }
    if (typeof body.note === "string") patch.note = body.note || null;
    const { error } = await svc.from("client_subscriptions").update(patch).eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  /* One-month price: { id, period: "YYYY-MM", amount } sets it, amount null
     removes it. Only that period's charge changes; the next month bills the
     normal amount again. Already-collected periods are refused. */
  if (action === "period_amount") {
    const period = String(body.period ?? "");
    if (!/^\d{4}-\d{2}$/.test(period)) return NextResponse.json({ error: "period must be YYYY-MM" }, { status: 400 });
    const { data: paid } = await svc.from("subscription_charges").select("id")
      .eq("subscription_id", id).eq("period_key", period).eq("status", "succeeded").maybeSingle();
    if (paid) return NextResponse.json({ error: `${period} is already charged` }, { status: 409 });
    if (body.amount == null) {
      const { error } = await svc.from("subscription_period_amounts").delete().eq("subscription_id", id).eq("period_key", period);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true });
    }
    const amount = Math.round(Number(body.amount) * 100);
    if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ error: "Bad amount" }, { status: 400 });
    const { error } = await svc.from("subscription_period_amounts").upsert({
      subscription_id: id, period_key: period, amount_cents: amount,
      reason: typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 200) : null,
      created_by: auth.email, created_at: now,
    }, { onConflict: "subscription_id,period_key" });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  /* Mark paid: the bill was charged by hand in Square (owner, 2026-10-06), so
     record it as collected — the unique index then stops the schedule from
     charging that month again — and move the next charge to the month after.
     The page sends the month it showed in the confirm; if the bill changed
     since, nothing is written. Status is left as it is: a paused subscription
     stays paused until someone presses Resume. */
  if (action === "mark_paid") {
    if (sub.status !== "active" && sub.status !== "paused")
      return NextResponse.json({ error: `Only an active or paused subscription can be marked paid (this one is ${sub.status})` }, { status: 400 });
    const { data: hist, error: histErr } = await svc.from("subscription_charges")
      .select("status, period_key, charged_at").eq("subscription_id", id);
    if (histErr) return NextResponse.json({ error: histErr.message }, { status: 500 });
    const period = owedPeriod(sub, (hist ?? []) as Array<{ status: string; period_key: string | null; charged_at: string }>);
    if (body.period !== period)
      return NextResponse.json({ error: `This bill changed since the page loaded (it's now ${period}) — reload and try again`, period }, { status: 409 });

    let price;
    try { price = await priceForPeriod(svc, sub, period); }
    catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Couldn't read the price" }, { status: 500 }); }
    const ledger = (hist ?? []) as Array<{ status: string; period_key: string | null; charged_at: string }>;
    const found = await findManualPayment(svc, sub, price.amountCents, paymentSince(sub, period, ledger))
      .catch((e) => ({ payment: null, note: `couldn't search Square (${e instanceof Error ? e.message.slice(0, 80) : "error"})` }));

    const { error: insErr } = await svc.from("subscription_charges").insert({
      subscription_id: id, owner_key: sub.owner_key,
      amount_cents: found.payment?.amountCents ?? price.amountCents,
      status: "succeeded", square_payment_id: found.payment?.id ?? null, receipt_url: found.payment?.receiptUrl ?? null,
      // "manual:" tells the ledger this was charged outside the dashboard.
      charged_by: `manual:${auth.email}`, period_key: period,
    });
    if (insErr) {
      return insErr.code === "23505"
        ? NextResponse.json({ error: `${period} is already marked paid` }, { status: 409 })
        : NextResponse.json({ error: insErr.message }, { status: 500 });
    }
    const next = nextAfterPaid(sub, period);
    const { error } = await svc.from("client_subscriptions").update({
      next_charge_on: next ?? sub.next_charge_on,
      status: next ? sub.status : "ended",
      retry_attempt: 0, retry_period: null, pause_reason: null, updated_at: now,
    }).eq("id", id);
    if (error) return NextResponse.json({ error: `Marked paid, but the next date didn't save: ${error.message}` }, { status: 500 });
    return NextResponse.json({
      success: true, period, next, status: next ? sub.status : "ended",
      payment: found.payment ? { amountCents: found.payment.amountCents, createdAt: found.payment.createdAt, receiptUrl: found.payment.receiptUrl } : null,
      note: found.note,
    });
  }

  if (action === "delete") {
    const { error } = await svc.from("client_subscriptions").delete().eq("id", id).eq("status", "draft");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: `Unknown action "${action}"` }, { status: 400 });
}
