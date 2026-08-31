import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { EmailOtpType } from "@supabase/supabase-js";

// Token-hash verification endpoint — unlike the PKCE /auth/callback flow, a
// token_hash link works in ANY browser/device: the admin can generate a reset
// link on their machine and the team member can open it on theirs. (The old
// flow failed with "PKCE code verifier not found in storage" cross-device.)
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const token_hash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const next = url.searchParams.get("next") ?? "/";

  if (token_hash && type) {
    const supabase = createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    if (!error) {
      return NextResponse.redirect(new URL(next, url.origin));
    }
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(`Link invalid or expired: ${error.message}`)}`, url.origin)
    );
  }
  return NextResponse.redirect(new URL("/login?error=Missing%20token", url.origin));
}
