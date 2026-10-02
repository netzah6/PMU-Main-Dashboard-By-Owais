import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getReplyAccount, sendConversationMessage } from "@/lib/ghl-conversations";
import { waitUntil } from "@vercel/functions";
import { settleDashboardSend } from "@/lib/reply-learning";

export const maxDuration = 30;

// MANUAL send into a PMU Bookings On Demand conversation — a human typed (or
// approved) this exact text and clicked Send on the dashboard. Nothing calls
// this automatically.
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { contactId?: string; message?: string; channel?: string };
  const contactId = String(body.contactId ?? "").trim();
  const message = String(body.message ?? "").trim();
  if (!contactId || !message) return NextResponse.json({ error: "contactId and message required" }, { status: 400 });
  if (message.length > 1500) return NextResponse.json({ error: "Message too long (1500 max)" }, { status: 400 });
  const channel = String(body.channel ?? "SMS");
  if (channel === "Email" || channel === "Call") {
    return NextResponse.json({ error: `${channel} chats can't be sent from here — open the chat in GHL` }, { status: 400 });
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
  const r = await sendConversationMessage(acct, { contactId, message, channel });
  if (!r.ok) return NextResponse.json({ error: r.error ?? "Send failed" }, { status: 502 });
  learn();
  return NextResponse.json({ success: true, ...(r.via ? { via: r.via } : {}) });
}
