import { NextRequest, NextResponse } from "next/server";
import { scanForProposals } from "@/lib/agent";

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
  return NextResponse.json(out);
}
