import type { NextRequest } from "next/server";

/* The address a SERVER job must use to call this app's own routes.

   Never the request's own host. Vercel triggers every cron job on the
   production DEPLOYMENT address (…-owais1-<hash>-<team>.vercel.app), and
   that address sits behind Vercel Authentication ("Standard Protection"
   covers every domain except the production domains). A server-side fetch
   from a cron to req.nextUrl.origin is therefore answered by Vercel's
   sign-in wall (401 / 302) and never reaches our code.

   Found 11/17/2026: Alicia Bailey (BeautyPros) paid her deposit, her browser
   never sent the booking call, and the paid-deposit safety net's own call to
   /api/onebox/book was refused, so she had no appointment for 10 hours.
   The same wall had silently stopped three other jobs: the insights scan's
   open-days check (86 calls a day, none arrived), the funnel timeline's
   engine copy (versions 130 and 131 never saved) and the video auto-booking.

   The public funnel domain is a production domain: it is open, it is the
   host every lead's browser uses for these same routes, and the
   funnel-health cron already loads it from cron context every 3 hours. */
const PUBLIC_ORIGIN = "https://book.pmu-care.com"; // same value as FUNNEL_ORIGIN (lib/onebox-add)

export function selfOrigin(req: NextRequest): string {
  const host = req.nextUrl.hostname;
  if (host === "localhost" || host === "127.0.0.1") return req.nextUrl.origin; // local dev talks to itself
  return (process.env.SELF_ORIGIN ?? "").replace(/\/+$/, "") || PUBLIC_ORIGIN;
}

/* Proof that the booking step answers from where this job runs: an empty
   POST must come back from OUR code ("missing fields", HTTP 400), before the
   route touches anything. A sign-in wall, a redirect or a timeout is a "no". */
export async function bookStepReachable(origin: string): Promise<{ ok: boolean; status: number; note: string }> {
  try {
    const r = await fetch(`${origin}/api/onebox/book`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      redirect: "manual", signal: AbortSignal.timeout(15_000),
    });
    const j = (await r.json().catch(() => null)) as { ok?: unknown; error?: unknown } | null;
    const ours = r.status === 400 && j?.ok === false && typeof j.error === "string";
    return { ok: ours, status: r.status, note: ours ? "reached" : `unexpected answer (HTTP ${r.status})` };
  } catch (e) {
    return { ok: false, status: 0, note: e instanceof Error ? e.message.slice(0, 120) : "fetch failed" };
  }
}
