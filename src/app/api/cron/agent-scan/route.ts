import { NextRequest, NextResponse } from "next/server";
import { scanForProposals } from "@/lib/agent";
import { learnFromSentReplies } from "@/lib/reply-learning";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Every 10 minutes: sweep unread client conversations and file proposals for
// the owner to approve on the AI tab. Detection only — nothing is sent or
// changed here.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const out = await scanForProposals();
  // Then learn: pair past AI drafts with what the team really sent (also
  // texts sent straight from GHL). Best-effort — never fails the scan.
  const learned = await learnFromSentReplies().catch((e) => ({ error: e instanceof Error ? e.message : "failed" }));
  return NextResponse.json({ ...out, learned });
}
