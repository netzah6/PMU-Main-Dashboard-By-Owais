import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

// book.pmu-care.com serves ONLY funnels, so it gets the short client URLs
// (book.pmu-care.com/<slug>) matching the pmu-care.com/BUSINESSNAME pattern.
// The /f/ namespace still exists everywhere — it's what keeps funnel slugs
// from colliding with dashboard routes on the main deployment domain.
const FUNNEL_HOST = "book.pmu-care.com";
/* The agency's own application funnel gets its own host: the root of
   book.pmubookingsondemand.com IS the pay-per-appointment funnel (slug
   "pps"); /<slug> under it works like book.pmu-care.com. */
const AGENCY_HOST = "book.pmubookingsondemand.com";
const AGENCY_ROOT_SLUG = "pps";
const RESERVED = new Set(["api", "f", "s", "login", "auth", "deck", "manifest.webmanifest"]);

/* This repo is deployed by TWO Vercel projects (pmu-main-dashboard-by-owais
   and …-owais1). Production — tokens, custom domains — is the "1" one; the
   other still fires every cron on the same schedule against the same
   database: on 2026-09-14 it re-ran the subscription charges 15 s after the
   real run with no Square token (401 "could not be authorized").
   Crons are refused on the SECONDARY project only. It is recognised by its
   own identity — the bare project URL, which has no custom domain — never by
   what production is called: the first version of this guard allow-listed
   "…owais1.vercel.app", but VERCEL_PROJECT_PRODUCTION_URL on production is
   the custom domain (book.pmu-care.com), so every cron was skipped for 13 h
   on 2026-09-14/15 (deposits, blasts, subscription retries, alerts, Square
   snapshot, CPL). */
const SECONDARY_PROJECT = "pmu-main-dashboard-by-owais";
function cronOnSecondaryProject(): boolean {
  const prod = (process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "").toLowerCase();
  const dep = (process.env.VERCEL_URL ?? "").toLowerCase();
  return prod === `${SECONDARY_PROJECT}.vercel.app` || dep.startsWith(`${SECONDARY_PROJECT}-`);
}

export async function middleware(request: NextRequest, event: NextFetchEvent) {
  if (request.nextUrl.pathname.startsWith("/api/cron/") && cronOnSecondaryProject()) {
    return NextResponse.json({ skipped: "secondary Vercel project — crons run on production only" });
  }
  const host = (request.headers.get("host") ?? "").toLowerCase();
  if (host === AGENCY_HOST && /^\/?$/.test(request.nextUrl.pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = `/f/${AGENCY_ROOT_SLUG}`;
    return NextResponse.rewrite(url);
  }
  if (host === FUNNEL_HOST || host === AGENCY_HOST) {
    /* AI follow-up payment links: /<slug>/confirm (or /last-step) lands the
       returning lead straight on the deposit step. Rewritten to the funnel
       page with pay=1; the personal ?t= token stays in the BROWSER url only
       (the engine reads it client-side), so the server response stays one
       cacheable entry per slug. */
    /* Preferred link shape ends with the friendly word, token in the
       middle: /<slug>/<contactId>/confirm — reads less spammy in a text
       than a trailing ?t= token (Netzah, 2026-09-18). The token stays in
       the BROWSER url; the engine parses it from the path. */
    const pt = request.nextUrl.pathname.match(/^\/([a-z0-9-]+)\/([A-Za-z0-9]{8,40})\/(confirm|last-step)\/?$/);
    if (pt && !RESERVED.has(pt[1].toLowerCase())) {
      const url = request.nextUrl.clone();
      url.pathname = `/f/${pt[1].toLowerCase()}`;
      url.search = "";
      const th = new Headers(request.headers);
      th.set("x-ob-pay", "1");
      return NextResponse.rewrite(url, { request: { headers: th } });
    }
    const pm = request.nextUrl.pathname.match(/^\/([a-z0-9-]+)\/(confirm|last-step)\/?$/i);
    if (pm && !RESERVED.has(pm[1].toLowerCase())) {
      const url = request.nextUrl.clone();
      url.pathname = `/f/${pm[1].toLowerCase()}`;
      url.search = "";
      /* Query params ADDED during a rewrite don't reach the route handler
         (only the original request's params survive) — the pay signal rides
         a request header instead, like x-ob-orig-search used to. */
      const ph = new Headers(request.headers);
      ph.set("x-ob-pay", "1");
      return NextResponse.rewrite(url, { request: { headers: ph } });
    }
    const m = request.nextUrl.pathname.match(/^\/([a-z0-9-]+)\/?$/i);
    if (m && !RESERVED.has(m[1].toLowerCase())) {
      const url = request.nextUrl.clone();
      url.pathname = `/f/${m[1].toLowerCase()}`;
      /* Ad clicks carry unique junk params (fbclid & friends), which made
         every paid visit its own CDN cache key — the funnel edge-cache
         missed on exactly the traffic we pay for (594ms vs 240ms TTFB).
         The server only reads ob_e/ob_v (+ the team's thank-you preview
         params); the pixel reads fbclid from the browser URL, which a
         rewrite doesn't touch. Everything else is dropped from the key. */
      const KEEP = new Set(["ob_e", "ob_v", "preview", "name"]);
      for (const k of [...url.searchParams.keys()]) {
        if (!KEEP.has(k)) url.searchParams.delete(k);
      }
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
  const isPublicMeta = p === "/manifest.webmanifest" || p.startsWith("/icon") || p.startsWith("/apple-icon")
    /* Apple Pay domain verification: Apple fetches this anonymously and
       the URL must answer 200 with no redirect. */
    || p.startsWith("/.well-known");
  // One-Box funnel pages are client-facing marketing pages — public by design.
  const isPublicFunnel = p.startsWith("/f/") || p.startsWith("/s/");
  /* The proposal deck is a prospect-facing page we hand out as a link, so it
     and its media must load without a dashboard session. */
  const isPublicDeck = p === "/deck" || p.startsWith("/deck/");

  if (!user && !isAuthRoute && !isApiRoute && !isAuthCallback && !isPublicMeta && !isPublicFunnel && !isPublicDeck) {
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
    // lead-pixel.js + the onebox engines are loaded by anonymous funnel visitors — they must bypass auth.
    "/((?!_next/static|_next/image|favicon.ico|lead-pixel.js|onebox.js|onebox-b2b.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
