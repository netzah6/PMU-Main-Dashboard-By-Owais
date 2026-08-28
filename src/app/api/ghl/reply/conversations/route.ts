import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
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

  // Resolve each conversation's assigned GHL user id to a name (for the filter).
  const nameById = new Map(roster.map((u) => [u.id, u.name]));
  const enriched = conversations.map((c) => ({
    ...c,
    assignedToName: c.assignedTo ? (nameById.get(c.assignedTo) ?? "") : "",
  }));

  // Visibility: team members only see chats ASSIGNED TO THEM (matched by
  // email → GHL user). Admins see everything + get the roster for filtering.
  const { data: roleRow } = await supabase.from("user_roles").select("role").eq("user_id", user.id).maybeSingle();
  const isAdmin = (roleRow as { role?: string } | null)?.role === "admin";
  const visible = isAdmin ? enriched : me.ghlUserId ? enriched.filter((c) => c.assignedTo === me.ghlUserId) : [];

  // The assignee filter should list only DASHBOARD team members (admin +
  // coaches), not every GHL user on the sub-account — match by email.
  const svc = createServiceClient();
  const { data: teamRows } = await svc.from("user_roles").select("email, role");
  const teamEmails = new Set(
    ((teamRows ?? []) as Array<{ email: string | null; role: string }>)
      .filter((r) => r.role === "admin" || r.role === "editor")
      .map((r) => String(r.email ?? "").toLowerCase())
      .filter(Boolean)
  );
  const teamRoster = roster.filter((u) => teamEmails.has(u.email));

  return NextResponse.json({
    me,
    role: isAdmin ? "admin" : "member",
    conversations: visible,
    locationId: acct.locationId,
    roster: isAdmin ? (teamRoster.length ? teamRoster : roster).map((u) => ({ id: u.id, name: u.name })) : undefined,
  });
}
