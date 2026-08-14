import { NextRequest, NextResponse } from "next/server";
import { scanChats } from "@/lib/ppa-chat-scan";

export const maxDuration = 300;

// Weekly chat scan (Sundays), so chat-detected bookings are waiting in the
// review panel before Monday's billing. Re-runnable: scan state in
// ppa_chat_flags means only conversations with new messages are re-read.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY is not configured." }, { status: 503 });
  }
  const summary = await scanChats();
  console.log(`[pps-chat-scan] clients=${summary.clients} scanned=${summary.scanned} flagged=${summary.flagged} partial=${summary.partial}`);
  return NextResponse.json(summary);
}
