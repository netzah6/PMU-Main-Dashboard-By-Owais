import { NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { scanChats } from "@/lib/ppa-chat-scan";

export const maxDuration = 300;

// On-demand chat scan from the PPS tab ("Scan chats" button). The Sunday cron
// wrapper lives at /api/cron/pps-chat-scan. Findings are review candidates
// only — nothing here charges anyone.
export async function POST() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY is not configured — the chat scan needs it." }, { status: 503 });
  }
  try {
    const summary = await scanChats();
    return NextResponse.json(summary);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Scan failed" }, { status: 502 });
  }
}
