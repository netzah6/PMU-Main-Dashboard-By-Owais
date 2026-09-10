import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { autochargeEnabled, advance, type Subscription } from "@/lib/subscriptions";

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
  const [{ data: subs }, { data: charges }, enabled] = await Promise.all([
    svc.from("client_subscriptions").select("*").order("created_at", { ascending: false }),
    svc.from("subscription_charges").select("*").order("charged_at", { ascending: false }).limit(400),
    autochargeEnabled(svc),
  ]);
  return NextResponse.json({ subscriptions: subs ?? [], charges: charges ?? [], autocharge: enabled });
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
    const patch: Record<string, unknown> = { status: "active", updated_at: now };
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

  if (action === "delete") {
    const { error } = await svc.from("client_subscriptions").delete().eq("id", id).eq("status", "draft");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: `Unknown action "${action}"` }, { status: 400 });
}
