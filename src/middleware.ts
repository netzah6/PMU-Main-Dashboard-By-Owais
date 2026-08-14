import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

// book.pmu-care.com serves ONLY funnels, so it gets the short client URLs
// (book.pmu-care.com/<slug>) matching the pmu-care.com/BUSINESSNAME pattern.
// The /f/ namespace still exists everywhere — it's what keeps funnel slugs
// from colliding with dashboard routes on the main deployment domain.
const FUNNEL_HOST = "book.pmu-care.com";
const RESERVED = new Set(["api", "f", "s", "login", "auth", "manifest.webmanifest"]);

export async function middleware(request: NextRequest, event: NextFetchEvent) {
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

  // ── VA restriction ──
  // A "va" may use only Clients and Onboarding. This is the real gate: hiding
  // tabs in TabNav is cosmetic, since typing /ceo or calling /api/ceo directly
  // would otherwise still work.
  //
  // Pages use an ALLOW-list (we know exactly which two are permitted). API
  // routes use a DENY-list instead: the two permitted pages pull from several
  // shared endpoints, and an api allow-list would silently break them as soon
  // as one of those pages gained a new data source. The deny-list names every
  // route carrying money, revenue, or agency-wide data.
  if (user && !isAuthCallback && !isPublicMeta && !isPublicFunnel) {
    const { data: roleRow } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .single();

    if (roleRow?.role === "va") {
      const VA_PAGES = ["/clients", "/onboarding"];
      const VA_DENIED_API = [
        "/api/ceo", "/api/ppa", "/api/square", "/api/refunds", "/api/ltv",
        "/api/cleanup", "/api/users", "/api/pool", "/api/territory", "/api/budget",
      ];

      if (isApiRoute) {
        if (VA_DENIED_API.some((d) => p === d || p.startsWith(d + "/"))) {
          return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
      } else if (!VA_PAGES.some((a) => p === a || p.startsWith(a + "/"))) {
        const url = request.nextUrl.clone();
        url.pathname = "/clients";
        url.search = "";
        return NextResponse.redirect(url);
      }
    }
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
    // lead-pixel.js + onebox.js are loaded by anonymous funnel visitors — they must bypass auth.
    "/((?!_next/static|_next/image|favicon.ico|lead-pixel.js|onebox.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
