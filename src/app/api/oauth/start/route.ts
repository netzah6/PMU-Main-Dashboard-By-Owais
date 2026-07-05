import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { appConfigured, authorizeUrl } from "@/lib/ghl-app";

// Kicks off the one-time Marketplace app install: redirects the (logged-in)
// admin to GHL's consent screen. A random state cookie guards the callback.
export async function GET(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", req.url));
  if (!appConfigured()) {
    return NextResponse.json(
      { error: "Marketplace app not configured — add GHL_APP_CLIENT_ID and GHL_APP_CLIENT_SECRET to the environment." },
      { status: 503 }
    );
  }

  const redirectUri = `${req.nextUrl.origin}/api/oauth/callback`;
  const state = crypto.randomUUID();
  const res = NextResponse.redirect(`${authorizeUrl(redirectUri)}&state=${state}`);
  res.cookies.set("ghl_oauth_state", state, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600, path: "/" });
  return res;
}
