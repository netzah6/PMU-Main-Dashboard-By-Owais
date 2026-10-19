import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { getReplyAccount } from "@/lib/ghl-conversations";
import { runSequence } from "@/lib/winback-sequence";

// The reply sweep covers everyone in a running sequence (not just the due
// ones), so a run can take a few minutes; runSequence budgets itself to 240 s.
export const maxDuration = 300;

/* Every 15 minutes: checks everyone in a started batch for a reply (or a
   teammate's message) and stops them, then sends the step that is due
   (day-0 text → day-3 nudge → day-7 email → day-14 close-out), 9am–7pm in
   their own timezone. ?dry=1 shows what WOULD go out and writes nothing —
   for the cron secret or an admin. */
export async function GET(req: NextRequest) {
  const dryRun = req.nextUrl.searchParams.get("dry") === "1";
  const authHeader = req.headers.get("authorization");
  // Texts go to real people, so a real send needs the cron secret — set AND
  // matching (the other crons skip the check when it's unset; this one won't).
  const cronOk = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;
  if (!cronOk) {
    // A dry run may also come from a logged-in admin; a real send never does.
    const auth = dryRun ? await getAuth().catch(() => null) : null;
    if (auth?.role !== "admin") {
      return NextResponse.json({ error: process.env.CRON_SECRET ? "Unauthorized" : "CRON_SECRET is not set — the win-back cron refuses to send without it" }, { status: 401 });
    }
  }
  const acct = await getReplyAccount();
  if (!acct) return NextResponse.json({ error: "PMU Bookings On Demand token not found" }, { status: 404 });
  try {
    const result = await runSequence(acct, { dryRun });
    return NextResponse.json({ timestamp: new Date().toISOString(), ...result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
