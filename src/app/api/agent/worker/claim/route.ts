import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { claimNext, workerAuthorized } from "@/lib/agent-worker";

// The Mac Mini asks for its next approved task (and says it's alive).
export async function POST(req: NextRequest) {
  if (!workerAuthorized(req.headers.get("authorization"))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { host?: string };
  const task = await claimNext(createServiceClient(), String(body.host ?? "mac-mini").slice(0, 60));
  return NextResponse.json({ task });
}
