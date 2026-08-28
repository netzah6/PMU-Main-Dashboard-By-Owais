import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getReplyAccount, sendConversationMessage } from "@/lib/ghl-conversations";
import { getAppLocationToken } from "@/lib/ghl-app";

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

  let r = await sendConversationMessage(acct, { contactId, message, channel });
  // The keys-sheet private token can lack the conversations-write scope
  // ("The token is not authorized for this scope"). Fall back to the
  // marketplace app's location token, which carries conversations/message.write
  // once the app is (re)authorized.
  if (!r.ok && /not authorized for this scope|401/i.test(r.error ?? "")) {
    const tok = await getAppLocationToken(acct.locationId);
    if (tok.token) {
      const retry = await sendConversationMessage({ locationId: acct.locationId, token: tok.token }, { contactId, message, channel });
      if (retry.ok) return NextResponse.json({ success: true, via: "app-token" });
      r = { ok: false, error: `private token: ${r.error} · app token: ${retry.error}` };
    }
  }
  if (!r.ok) return NextResponse.json({ error: r.error ?? "Send failed" }, { status: 502 });
  return NextResponse.json({ success: true });
}
