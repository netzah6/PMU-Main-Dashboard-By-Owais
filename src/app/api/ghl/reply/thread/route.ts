import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getReplyAccount, getThread } from "@/lib/ghl-conversations";

export const maxDuration = 60;

// Full message history for one PMU Bookings On Demand conversation, so the AI
// tab can show the whole thread (not just the truncated preview) when a chat is
// opened — read it before writing the note that steers the draft.
export async function GET(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const conversationId = req.nextUrl.searchParams.get("conversationId");
  if (!conversationId) {
    return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
  }

  const acct = await getReplyAccount();
  if (!acct) return NextResponse.json({ error: "Account not found" }, { status: 404 });

  const messages = await getThread(acct, conversationId);
  return NextResponse.json({ messages });
}
