import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

export async function middleware(request: NextRequest, event: NextFetchEvent) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isAuthRoute = request.nextUrl.pathname.startsWith("/login");
  const isApiRoute = request.nextUrl.pathname.startsWith("/api");
  // The invite/recovery callback must run while the user is still unauthenticated
  // (it's what creates the session), so it can't be gated behind the login redirect.
  const isAuthCallback = request.nextUrl.pathname.startsWith("/auth");
  // PWA metadata (manifest + generated icons) must be reachable before login,
  // so the phone can install the app and show its icon.
  const p = request.nextUrl.pathname;
  const isPublicMeta = p === "/manifest.webmanifest" || p.startsWith("/icon") || p.startsWith("/apple-icon");

  if (!user && !isAuthRoute && !isApiRoute && !isAuthCallback && !isPublicMeta) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (user && isAuthRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/clients";
    return NextResponse.redirect(url);
  }

  // ── Admin activity log ──
  // Every CHANGE a logged-in team member makes goes through a mutating /api
  // call — record who did what, fire-and-forget so requests aren't slowed.
  // Cron/automation calls have no user session and are skipped automatically.
  if (user?.email && isApiRoute && ["POST", "PATCH", "PUT", "DELETE"].includes(request.method)) {
    const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (svcKey) {
      event.waitUntil(
        fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/audit_log`, {
          method: "POST",
          headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}`, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({
            user_email: user.email,
            method: request.method,
            path: request.nextUrl.pathname,
            query: request.nextUrl.search ? request.nextUrl.search.slice(0, 500) : null,
          }),
        }).catch(() => {})
      );
    }
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    // lead-pixel.js is loaded by anonymous funnel visitors — it must bypass auth.
    "/((?!_next/static|_next/image|favicon.ico|lead-pixel.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
