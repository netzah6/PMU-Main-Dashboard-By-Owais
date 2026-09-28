import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient, createServiceClient } from "@/lib/supabase/server";

// Admin-only: revoke a team member's dashboard access (Settings → Remove).
//
// Three steps, in this order:
//   1. ban the auth user      — they can never sign in again
//   2. kill their sessions    — any open tab is signed out now, not in an hour
//   3. delete their role row  — they disappear from the Team Members list
//
// The auth.users row itself is kept on purpose: client_activity.created_by
// references it, so deleting the account would erase who wrote each note.
// Re-inviting the same email later lifts the ban (see /api/users/invite).
const BAN_FOREVER = "876000h"; // ~100 years; Supabase takes a Go duration

export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const svc = createServiceClient();
  const { data: roleData } = await svc
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .single();
  if (roleData?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden — admin only" }, { status: 403 });
  }

  const { userId } = await req.json();
  if (!userId || typeof userId !== "string") {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }
  if (userId === user.id) {
    return NextResponse.json({ error: "You can't remove your own access" }, { status: 400 });
  }

  const { data: target } = await svc
    .from("user_roles")
    .select("email, role")
    .eq("user_id", userId)
    .maybeSingle();
  if (!target) {
    return NextResponse.json({ error: "That member is not on the team list" }, { status: 404 });
  }

  // auth.admin needs a plain service-role client (not the SSR cookie client).
  const admin = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const { error: banError } = await admin.auth.admin.updateUserById(userId, {
    ban_duration: BAN_FOREVER,
  });
  if (banError) {
    return NextResponse.json({ error: `Could not block sign-in: ${banError.message}` }, { status: 500 });
  }

  const { data: sessionsKilled, error: revokeError } = await svc.rpc("revoke_user_sessions", { uid: userId });
  if (revokeError) {
    // The ban already holds; they just stay signed in until their token expires (≤1 h).
    console.error("[users/remove] revoke_user_sessions failed:", revokeError.message);
  }

  const { error: roleError } = await svc.from("user_roles").delete().eq("user_id", userId);
  if (roleError) {
    return NextResponse.json({ error: `Blocked sign-in, but could not remove the role: ${roleError.message}` }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    email: target.email,
    sessionsKilled: typeof sessionsKilled === "number" ? sessionsKilled : null,
    sessionsRevoked: !revokeError,
  });
}
