import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(req: NextRequest) {
  // Verify requester is admin
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const adminClient = createServiceClient();
  const { data: roleData } = await adminClient
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .single();

  if (roleData?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden — admin only" }, { status: 403 });
  }

  const { email, role } = await req.json();

  if (!email || !role) {
    return NextResponse.json({ error: "email and role required" }, { status: 400 });
  }

  // The invite email link returns here; the callback exchanges the token for a
  // session and forwards to the set-password page so the user can finish signup.
  const origin = req.headers.get("origin") ?? req.nextUrl.origin;
  const redirectTo = `${origin}/auth/callback?next=/set-password`;

  // Invite via Supabase Admin API. If the address already has an account, fall
  // back to looking it up so we can still (re)assign the role instead of erroring.
  let userId: string | null = null;
  let alreadyExisted = false;

  const { data: inviteData, error: inviteError } =
    await adminClient.auth.admin.inviteUserByEmail(email, { redirectTo });

  if (inviteError) {
    const msg = inviteError.message.toLowerCase();
    const isExisting =
      msg.includes("already") || msg.includes("registered") || msg.includes("exists");
    if (!isExisting) {
      return NextResponse.json({ error: inviteError.message }, { status: 500 });
    }
    // Find the existing user by email so we can update their role.
    const { data: list } = await adminClient.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const existing = list?.users.find(
      (u) => u.email?.toLowerCase() === String(email).toLowerCase()
    );
    if (!existing) {
      return NextResponse.json({ error: inviteError.message }, { status: 500 });
    }
    userId = existing.id;
    alreadyExisted = true;
  } else {
    userId = inviteData.user.id;
  }

  // Create / update the role record — conflict on user_id (now a unique key) so
  // re-invites and role changes update instead of failing.
  const { error: roleError } = await adminClient
    .from("user_roles")
    .upsert({ user_id: userId, email, role }, { onConflict: "user_id" });

  if (roleError) {
    return NextResponse.json({ error: roleError.message }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    userId,
    alreadyExisted,
    message: alreadyExisted
      ? "User already had an account — role updated (no new invite email sent)."
      : "Invitation email sent.",
  });
}
