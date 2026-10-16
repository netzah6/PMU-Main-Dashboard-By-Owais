import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { SETUP_PREFIX } from "@/lib/setup-run";
import { SNAPSHOT_PREFIX } from "@/lib/pool-snapshot";

/* The Mac Mini tracker (owner, 2026-10-16: "I switch tabs and come back and I
   have no idea what's going on"). A light read polled every ~20 s: what the
   Mini is doing or waiting to do, and what it finished in the last 12 hours.
   Admin only, same as the agent inbox.

   ?scope=onboarding → New Client Setup steps + clean-account snapshot loads
   (shown on the Onboarding tab); ?scope=agent → everything else, i.e. the
   tasks you approve on the AI tab. Each tab shows only its own. */
const FINISHED_WINDOW_MS = 12 * 3600_000;

export async function GET(req: NextRequest) {
  const scope = req.nextUrl.searchParams.get("scope") === "onboarding" ? "onboarding" : "agent";
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const svc = createServiceClient();
  const { data: roleRow } = await svc.from("user_roles").select("role").eq("user_id", user.id).maybeSingle();
  if ((roleRow as { role?: string } | null)?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden — admin only" }, { status: 403 });
  }

  const cols = "id, conversation_id, contact_name, summary, status, created_at, browser_claimed_at, browser_attempts, executed_at";
  const since = new Date(Date.now() - FINISHED_WINDOW_MS).toISOString();
  const [active, finished, worker] = await Promise.all([
    svc.from("agent_proposals").select(cols).in("status", ["queued_browser", "running"])
      .order("created_at", { ascending: true }).limit(60),
    svc.from("agent_proposals").select(cols).in("status", ["done", "failed", "needs_teammate"])
      .gte("executed_at", since).order("executed_at", { ascending: false }).limit(60),
    svc.from("app_settings").select("value").eq("key", "agent_worker").maybeSingle(),
  ]);
  const err = active.error ?? finished.error;
  if (err) return NextResponse.json({ error: err.message }, { status: 500 });

  const isOnboarding = (r: { conversation_id: string | null }) =>
    !!r.conversation_id && (r.conversation_id.startsWith(SETUP_PREFIX) || r.conversation_id.startsWith(SNAPSHOT_PREFIX));
  const mine = (rows: { conversation_id: string | null }[] | null) =>
    (rows ?? []).filter((r) => isOnboarding(r) === (scope === "onboarding"));

  return NextResponse.json({
    worker: (worker.data as { value?: unknown } | null)?.value ?? null,
    active: mine(active.data).slice(0, 30),
    finished: mine(finished.data).slice(0, 20),
  });
}
