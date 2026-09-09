import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";

// Chat-detected bookings awaiting review (GET), and the review decisions
// (POST dismiss / mark-billed). Billing itself goes through /api/ppa/charge
// with appt_id 'chat:<conversation_id>' — this route only tracks the flag.
export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const svc = createServiceClient();
  const [{ data: flags }, { data: lastScan }, { data: refunds }] = await Promise.all([
    svc.from("ppa_chat_flags")
      .select("conversation_id, owner_key, location_id, contact_id, contact_name, detected_when, detected_date, evidence, last_message_at")
      .eq("verdict", "booked").eq("dismissed", false).eq("billed", false)
      .order("last_message_at", { ascending: false }),
    svc.from("ppa_chat_flags").select("scanned_at").order("scanned_at", { ascending: false }).limit(1).maybeSingle(),
    svc.from("deposit_refunds").select("contact_name, email").eq("status", "refunded"),
  ]);

  // A refunded deposit means the session never happened — that lead must not
  // resurface as a billable chat booking (Santos M Alcocer did: refund logged
  // as "Santos M", chat contact "Santos M Alcocer" — hence containment
  // matching, not equality).
  const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const refundNames = ((refunds ?? []) as Array<{ contact_name: string | null }>)
    .map((r) => norm(r.contact_name)).filter((n) => n.length >= 6);
  const refunded = (name: string | null) => {
    const n = norm(name);
    if (n.length < 6) return false;
    return refundNames.some((r) => r.includes(n) || n.includes(r));
  };
  const visible = ((flags ?? []) as Array<{ contact_name: string | null; contact_id: string | null; detected_date: string | null }>)
    .filter((f) => !refunded(f.contact_name));

  // "We only charge AFTER the appointment happened": a flag whose detected
  // date — or whose contact's calendar appointment — is still in the future
  // is HELD (the panel shows "billable after <date>" instead of Bill).
  const ids = visible.map((f) => f.contact_id).filter(Boolean) as string[];
  const futureByContact = new Map<string, string>();
  if (ids.length) {
    const { data: appts } = await svc.from("ghl_appointments")
      .select("contact_id, start_time").in("contact_id", ids).gt("start_time", new Date().toISOString());
    for (const a of (appts ?? []) as Array<{ contact_id: string | null; start_time: string | null }>) {
      if (!a.contact_id || !a.start_time) continue;
      const cur = futureByContact.get(a.contact_id);
      if (!cur || a.start_time < cur) futureByContact.set(a.contact_id, a.start_time);
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  const withHold = visible.map((f) => {
    const flagFuture = f.detected_date && f.detected_date > today ? f.detected_date : null;
    const calFuture = f.contact_id ? (futureByContact.get(f.contact_id) ?? null) : null;
    const billableAfter = [flagFuture, calFuture ? calFuture.slice(0, 10) : null]
      .filter(Boolean).sort().pop() ?? null;
    return { ...f, billableAfter };
  });

  return NextResponse.json({ flags: withHold, lastScanAt: lastScan?.scanned_at ?? null });
}

export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { conversation_id?: string; action?: string };
  const id = String(body.conversation_id ?? "").trim();
  const action = String(body.action ?? "");
  if (!id || !["dismiss", "billed", "restore"].includes(action)) {
    return NextResponse.json({ error: "conversation_id and action (dismiss|billed|restore) required" }, { status: 400 });
  }
  const svc = createServiceClient();
  const patch = action === "dismiss" ? { dismissed: true } : action === "billed" ? { billed: true } : { dismissed: false, billed: false };
  const { error } = await svc.from("ppa_chat_flags").update(patch).eq("conversation_id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
