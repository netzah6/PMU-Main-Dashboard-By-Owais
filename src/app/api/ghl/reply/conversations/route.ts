import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getReplyAccount, getRecentConversations, getRoster } from "@/lib/ghl-conversations";

export const maxDuration = 60;

// Recent conversations for PMU Bookings On Demand + which GHL team member the
// logged-in dashboard user maps to (matched by email).
export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const acct = await getReplyAccount();
  if (!acct) {
    return NextResponse.json(
      { error: "PMU Bookings On Demand token not found in the keys sheet" },
      { status: 404 }
    );
  }

  const email = (user.email ?? "").toLowerCase();
  // Only show conversations that are unread in GHL (mirrors GHL's "Unread" tab).
  const [roster, conversations] = await Promise.all([
    getRoster(acct),
    getRecentConversations(acct, 100, { unreadOnly: true }),
  ]);

  const meUser = roster.find((u) => u.email && u.email === email) ?? null;
  const me = {
    matched: !!meUser,
    ghlUserId: meUser?.id ?? null,
    name: meUser?.name ?? (email ? email.split("@")[0] : "You"),
  };

  return NextResponse.json({ me, conversations });
}
