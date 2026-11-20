import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { touchWorker, workerAuthorized } from "@/lib/agent-worker";
import { onLoginHealth, type LoginHealth } from "@/lib/agent-login-health";

// The Mac Mini says "still alive" once a minute while a task runs, so the
// dashboard's Mac Mini pill stays green mid-task (claims only happen between tasks).
// Once an hour it also sends its saved-login counts (see agent-login-health).
export async function POST(req: NextRequest) {
  if (!workerAuthorized(req.headers.get("authorization"))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { host?: string; task?: string; logins?: LoginHealth };
  const svc = createServiceClient();
  await touchWorker(svc, String(body.host ?? "mac-mini").slice(0, 60), body.task ? String(body.task).slice(0, 40) : undefined);
  if (body.logins && typeof body.logins === "object") {
    try { await onLoginHealth(svc, body.logins); } catch { /* the next hourly report tries again */ }
  }
  return NextResponse.json({ ok: true });
}
