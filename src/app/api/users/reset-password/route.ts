import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient, createServiceClient } from "@/lib/supabase/server";

// Admin-only: create a password-reset LINK for a team member. The old flow
// emailed a PKCE link, which only works in the browser that initiated it —
// the member opening it on their own device hit "PKCE code verifier not found
// in storage". Now we mint a token-hash recovery link via the admin API
// (works on any device, /auth/confirm verifies it) and hand it back to the
// admin to copy and send directly.
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

  const { email } = await req.json();
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });

  // auth.admin needs a plain service-role client (not the SSR cookie client).
  const admin = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
  const { data, error } = await admin.auth.admin.generateLink({
    type: "recovery",
    email: String(email),
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const tokenHash = data.properties?.hashed_token;
  if (!tokenHash) return NextResponse.json({ error: "No token in response — try again" }, { status: 500 });

  const origin = req.headers.get("origin") ?? req.nextUrl.origin;
  const link = `${origin}/auth/confirm?token_hash=${encodeURIComponent(tokenHash)}&type=recovery&next=/set-password`;
  return NextResponse.json({ success: true, link });
}
