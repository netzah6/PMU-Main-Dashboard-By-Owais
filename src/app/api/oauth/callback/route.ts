import { NextRequest, NextResponse } from "next/server";
import { exchangeCode } from "@/lib/ghl-app";

export const maxDuration = 30;

// GHL redirects here after the admin approves the app install.
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const cookieState = req.cookies.get("ghl_oauth_state")?.value;

  if (!code) {
    return NextResponse.redirect(new URL("/onboarding?ghl=error&reason=no_code", req.url));
  }
  if (!state || !cookieState || state !== cookieState) {
    return NextResponse.redirect(new URL("/onboarding?ghl=error&reason=bad_state", req.url));
  }

  try {
    await exchangeCode(code, `${req.nextUrl.origin}/api/oauth/callback`);
    const res = NextResponse.redirect(new URL("/onboarding?ghl=connected", req.url));
    res.cookies.delete("ghl_oauth_state");
    return res;
  } catch (e) {
    console.error("[ghl-oauth] exchange failed:", e);
    return NextResponse.redirect(new URL("/onboarding?ghl=error&reason=exchange_failed", req.url));
  }
}
