import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { touchWorker, workerAuthorized } from "@/lib/agent-worker";

// The Mac Mini says "still alive" once a minute while a task runs, so the
// dashboard's Mac Mini pill stays green mid-task (claims only happen between tasks).
export async function POST(req: NextRequest) {
  if (!workerAuthorized(req.headers.get("authorization"))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { host?: string; task?: string };
  await touchWorker(createServiceClient(), String(body.host ?? "mac-mini").slice(0, 60), body.task ? String(body.task).slice(0, 40) : undefined);
  return NextResponse.json({ ok: true });
}
