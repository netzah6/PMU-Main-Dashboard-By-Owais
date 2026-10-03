import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getReplyAccount, sendConversationMessage } from "@/lib/ghl-conversations";
import { waitUntil } from "@vercel/functions";
import { settleDashboardSend } from "@/lib/reply-learning";

export const maxDuration = 30;

// MANUAL send into a PMU Bookings On Demand conversation — a human typed (or
// approved) this exact text and clicked Send on the dashboard. Nothing calls
// this automatically. With scheduleAt (ISO time) GHL holds the text and sends
// it then (owner, 2026-10-03); it is listed in scheduled_messages so the
// dashboard can show and cancel it.
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { contactId?: string; message?: string; channel?: string; scheduleAt?: string; contactName?: string };
  const contactId = String(body.contactId ?? "").trim();
  const message = String(body.message ?? "").trim();
  if (!contactId || !message) return NextResponse.json({ error: "contactId and message required" }, { status: 400 });
  if (message.length > 1500) return NextResponse.json({ error: "Message too long (1500 max)" }, { status: 400 });
  const channel = String(body.channel ?? "SMS");
  if (channel === "Email" || channel === "Call") {
    return NextResponse.json({ error: `${channel} chats can't be sent from here — open the chat in GHL` }, { status: 400 });
  }

  let scheduledAt: number | undefined;
  if (body.scheduleAt) {
    const t = Date.parse(String(body.scheduleAt));
    if (!Number.isFinite(t)) return NextResponse.json({ error: "Bad schedule time" }, { status: 400 });
    if (t < Date.now() + 60_000) return NextResponse.json({ error: "Pick a time at least a minute from now" }, { status: 400 });
    if (t > Date.now() + 60 * 86_400_000) return NextResponse.json({ error: "Pick a time within 60 days" }, { status: 400 });
    scheduledAt = Math.floor(t / 1000);
  }

  const acct = await getReplyAccount();
  if (!acct) return NextResponse.json({ error: "PMU Bookings On Demand token not found" }, { status: 404 });

  // The AI learns from what was really sent — paired with this sender's own
  // draft here, since the GHL message won't say who sent it.
  const learn = () => waitUntil(settleDashboardSend({
    contactId, sent: message, senderEmail: user.email ?? "", pairOwnDraft: true,
  }).catch(() => undefined));

  // Falls back to the app's location token by itself when the private token
  // can't send (see sendConversationMessage).
  const r = await sendConversationMessage(acct, { contactId, message, channel, scheduledAt });
  if (!r.ok) return NextResponse.json({ error: r.error ?? "Send failed" }, { status: 502 });
  // A scheduled text hasn't gone out (and may be cancelled) — the AI only
  // learns from texts that were really sent.
  if (!scheduledAt) learn();
  if (scheduledAt) {
    const scheduledFor = new Date(scheduledAt * 1000).toISOString();
    const { data: row } = await createServiceClient().from("scheduled_messages").insert({
      contact_id: contactId, contact_name: body.contactName ? String(body.contactName).slice(0, 200) : null,
      channel, message, scheduled_for: scheduledFor, ghl_message_id: r.messageId ?? null, created_by: user.email ?? user.id,
    }).select("id").single();
    return NextResponse.json({ success: true, scheduled: true, scheduledFor, id: (row as { id?: string } | null)?.id ?? null, cancellable: !!r.messageId });
  }
  return NextResponse.json({ success: true, ...(r.via ? { via: r.via } : {}) });
}
