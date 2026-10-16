import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";

/* The Mac Mini tracker on every tab (owner, 2026-10-16: "I switch tabs and come
   back and I have no idea what's going on"). A light read polled every ~20 s:
   what the Mini is doing or waiting to do, and what it finished in the last
   12 hours. Admin only, same as the agent inbox. */
const FINISHED_WINDOW_MS = 12 * 3600_000;

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const svc = createServiceClient();
  const { data: roleRow } = await svc.from("user_roles").select("role").eq("user_id", user.id).maybeSingle();
  if ((roleRow as { role?: string } | null)?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden — admin only" }, { status: 403 });
  }

  const cols = "id, contact_name, summary, status, created_at, browser_claimed_at, browser_attempts, executed_at";
  const since = new Date(Date.now() - FINISHED_WINDOW_MS).toISOString();
  const [active, finished, worker] = await Promise.all([
    svc.from("agent_proposals").select(cols).in("status", ["queued_browser", "running"])
      .order("created_at", { ascending: true }).limit(30),
    svc.from("agent_proposals").select(cols).in("status", ["done", "failed", "needs_teammate"])
      .gte("executed_at", since).order("executed_at", { ascending: false }).limit(20),
    svc.from("app_settings").select("value").eq("key", "agent_worker").maybeSingle(),
  ]);
  const err = active.error ?? finished.error;
  if (err) return NextResponse.json({ error: err.message }, { status: 500 });

  return NextResponse.json({
    now: new Date().toISOString(),
    worker: (worker.data as { value?: unknown } | null)?.value ?? null,
    active: active.data ?? [],
    finished: finished.data ?? [],
  });
}
