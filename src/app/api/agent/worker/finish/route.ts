import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { finishTask, workerAuthorized, type FinishInput } from "@/lib/agent-worker";

export const maxDuration = 60; // screenshot uploads + the owner's text

// The Mac Mini reports how a task went, with its screenshots.
export async function POST(req: NextRequest) {
  if (!workerAuthorized(req.headers.get("authorization"))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as FinishInput | null;
  if (!body?.id || !["done", "failed", "needs_teammate"].includes(body.status) || !body.summary) {
    return NextResponse.json({ error: "id, status (done|failed|needs_teammate) and summary required" }, { status: 400 });
  }
  const r = await finishTask(createServiceClient(), body);
  return r.ok ? NextResponse.json({ success: true }) : NextResponse.json({ error: r.error }, { status: 409 });
}
