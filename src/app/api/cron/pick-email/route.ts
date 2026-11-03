import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { createServiceClient } from "@/lib/supabase/server";
import { runPickEmail } from "@/lib/pick-email";

export const fetchCache = "force-no-store";
export const maxDuration = 300;

/* Every 10 minutes: the "finish your deposit" email (src/lib/pick-email.ts).
   Does nothing while the switch on the Funnels tab is off. ?dry=1 shows what
   WOULD go out and writes nothing — for the cron secret or an admin;
   &since=<ISO> stands in for the switch-on moment so it can be tried while off. */
export async function GET(req: NextRequest) {
  const dryRun = req.nextUrl.searchParams.get("dry") === "1";
  const authHeader = req.headers.get("authorization");
  // Emails go to real people, so a real send needs the cron secret — set AND matching.
  const cronOk = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;
  if (!cronOk) {
    const auth = dryRun ? await getAuth().catch(() => null) : null;
    if (auth?.role !== "admin") {
      return NextResponse.json({ error: process.env.CRON_SECRET ? "Unauthorized" : "CRON_SECRET is not set — the deposit email refuses to send without it" }, { status: 401 });
    }
  }
  const since = req.nextUrl.searchParams.get("since");
  if (since && !Number.isFinite(Date.parse(since))) return NextResponse.json({ error: "since must be an ISO date" }, { status: 400 });
  try {
    const result = await runPickEmail(createServiceClient(), { dryRun, sinceIso: since ?? undefined });
    return NextResponse.json({ timestamp: new Date().toISOString(), ...result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
