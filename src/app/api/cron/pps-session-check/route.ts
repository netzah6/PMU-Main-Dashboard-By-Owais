import { NextRequest, NextResponse } from "next/server";
import { verifySessions } from "@/lib/pps-session-check";

export const maxDuration = 300;

// Sunday session check, after the chat scan: the AI reads each billable-
// without-proof appointment's chat (past-due deposits, past calendar
// bookings, no-deposit "Deposit Collected" leads, chat bookings) and bills,
// voids or holds it before Monday's auto-charge. Runs several times on
// Sunday; each run skips what an earlier run already checked this week.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY is not configured." }, { status: 503 });
  }
  const owner = req.nextUrl.searchParams.get("owner") ?? undefined;
  const summary = await verifySessions(240_000, owner);
  console.log(`[pps-session-check] candidates=${summary.candidates} checked=${summary.checked} billed=${summary.billed} voided=${summary.voided} held=${summary.held} partial=${summary.partial}`);
  return NextResponse.json(summary);
}
