import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { cancelScheduledMessage, getReplyAccount } from "@/lib/ghl-conversations";

export const maxDuration = 30;

// Texts scheduled from the AI tab (owner, 2026-10-03).
//   GET  ?contactId=…  → the upcoming ones for that contact
//   POST { id }        → cancel one (GHL stops holding it)
// Admins see and cancel anyone's; everyone else only their own.

export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const contactId = req.nextUrl.searchParams.get("contactId") ?? "";
  if (!contactId) return NextResponse.json({ error: "contactId required" }, { status: 400 });
  let q = createServiceClient().from("scheduled_messages")
    .select("id, contact_name, message, scheduled_for, created_by, ghl_message_id")
    .eq("contact_id", contactId).eq("status", "scheduled")
    .gt("scheduled_for", new Date().toISOString()).order("scheduled_for", { ascending: true });
  if (auth.role !== "admin") q = q.eq("created_by", auth.email ?? auth.userId);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ scheduled: data ?? [] });
}

export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { id?: string };
  const svc = createServiceClient();
  const { data: row } = await svc.from("scheduled_messages").select("*").eq("id", String(body.id ?? "")).maybeSingle();
  const r0 = row as { id: string; status: string; created_by: string; ghl_message_id: string | null; scheduled_for: string } | null;
  if (!r0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (auth.role !== "admin" && r0.created_by !== (auth.email ?? auth.userId)) return NextResponse.json({ error: "Only who scheduled it (or an admin) can cancel it" }, { status: 403 });
  if (r0.status !== "scheduled") return NextResponse.json({ error: "Already canceled" }, { status: 409 });
  if (Date.parse(r0.scheduled_for) <= Date.now()) return NextResponse.json({ error: "Too late — it was due to send already" }, { status: 409 });
  if (!r0.ghl_message_id) return NextResponse.json({ error: "GHL didn't return an id for this one — cancel it in the GHL chat" }, { status: 422 });
  const acct = await getReplyAccount();
  if (!acct) return NextResponse.json({ error: "PMU Bookings On Demand token not found" }, { status: 503 });
  const c = await cancelScheduledMessage(acct, r0.ghl_message_id);
  if (!c.ok) return NextResponse.json({ error: `GHL didn't cancel it: ${c.error} — cancel it in the GHL chat` }, { status: 502 });
  await svc.from("scheduled_messages").update({ status: "canceled", canceled_by: auth.email ?? auth.userId, canceled_at: new Date().toISOString() }).eq("id", r0.id);
  return NextResponse.json({ ok: true });
}
