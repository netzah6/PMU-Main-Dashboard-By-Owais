import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Never let Next.js cache Supabase REST calls: Vercel's Data Cache memoizes
// plain GET fetches ACROSS invocations, so a "no rows yet" dedupe check or a
// cursor read can come back stale minutes later (caught 2026-08-28: the alerts
// cron re-filed alerts because its existence check was served from cache).
const freshFetch: typeof fetch = (url, init) => fetch(url, { ...init, cache: "no-store" });

export function createClient() {
  const cookieStore = cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { fetch: freshFetch },
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {}
        },
      },
    }
  );
}

export function createServiceClient() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      global: { fetch: freshFetch },
      cookies: {
        getAll() {
          return [];
        },
        setAll() {},
      },
    }
  );
}
