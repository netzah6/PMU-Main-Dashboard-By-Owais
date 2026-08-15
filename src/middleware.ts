import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

// book.pmu-care.com serves ONLY funnels, so it gets the short client URLs
// (book.pmu-care.com/<slug>) matching the pmu-care.com/BUSINESSNAME pattern.
// The /f/ namespace still exists everywhere — it's what keeps funnel slugs
// from colliding with dashboard routes on the main deployment domain.
const FUNNEL_HOST = "book.pmu-care.com";
const RESERVED = new Set(["api", "f", "s", "login", "auth", "manifest.webmanifest"]);

export async function middleware(request: NextRequest, event: NextFetchEvent) {
  // Server components can't read the current path. Forward it so the (dashboard)
  // layout can enforce the VA role gate — middleware itself must stay DB-free.
  request.headers.set("x-pathname", request.nextUrl.pathname);

  const host = (request.headers.get("host") ?? "").toLowerCase();
  if (host === FUNNEL_HOST) {
    const m = request.nextUrl.pathname.match(/^\/([a-z0-9-]+)\/?$/i);
    if (m && !RESERVED.has(m[1].toLowerCase())) {
      const url = request.nextUrl.clone();
      url.pathname = `/f/${m[1].toLowerCase()}`;
      return NextResponse.rewrite(url);
    }
  }

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
  // One-Box funnel pages are client-facing marketing pages — public by design.
  const isPublicFunnel = p.startsWith("/f/") || p.startsWith("/s/");

  if (!user && !isAuthRoute && !isApiRoute && !isAuthCallback && !isPublicMeta && !isPublicFunnel) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (user && isAuthRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/clients";
    return NextResponse.redirect(url);
  }

  // The VA role gate used to live here and did a `user_roles` lookup on EVERY
  // request. That took the whole dashboard down with
  // MIDDLEWARE_INVOCATION_TIMEOUT: middleware runs on every page, asset and API
  // call, so one DB round trip per request piles up — and it queued behind the
  // heavy performance_overview queries until middleware blew its limit.
  //
  // The gate now lives in the (dashboard) layout, which already runs server-side
  // once per page render rather than once per request.

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
    // lead-pixel.js + onebox.js are loaded by anonymous funnel visitors — they must bypass auth.
    "/((?!_next/static|_next/image|favicon.ico|lead-pixel.js|onebox.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
