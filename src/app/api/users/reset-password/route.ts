import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";

// Admin-only: email a password-reset link to a team member. Covers the two
// cases the invite flow can't: an expired invite link (re-inviting an existing
// account sends NO email) and a forgotten password (the login page has no
// "forgot password"). The link lands on /auth/callback → /set-password, the
// same page invites use, so the member just types a new password.
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminClient = createServiceClient();
  const { data: roleData } = await adminClient
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .single();
  if (roleData?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden — admin only" }, { status: 403 });
  }

  const { email } = await req.json();
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });

  const origin = req.headers.get("origin") ?? req.nextUrl.origin;
  const { error } = await adminClient.auth.resetPasswordForEmail(String(email), {
    redirectTo: `${origin}/auth/callback?next=/set-password`,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true, message: `Password-reset email sent to ${email}.` });
}
