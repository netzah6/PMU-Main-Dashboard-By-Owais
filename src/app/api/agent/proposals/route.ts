import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { agentAccess, canSee } from "@/lib/agent-access";

// The CEO agent's proposal inbox — admins see all; coaches their own clients' cards.
export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const svc = createServiceClient();
  const access = await agentAccess(svc, user);
  if (!access) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data, error } = await svc
    .from("agent_proposals")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(access.isAdmin ? 60 : 200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const proposals = (data ?? []).filter((p) => !String((p as { conversation_id?: string }).conversation_id ?? "").startsWith("keepalive:")).filter((p) => !String((p as { conversation_id?: string }).conversation_id ?? "").startsWith("igengage:")).filter((p) => canSee(access, p as { contact_name?: string | null; action_detail?: string | null; action_type?: string | null; client_message?: string | null })).slice(0, 60);
  // What the last scan did (and why it skipped what it skipped).
  const { data: lastScan } = await svc.from("app_settings").select("value").eq("key", "agent_scan_last").maybeSingle();
  // When the Mac Mini last asked for work — shows online / offline.
  const { data: worker } = await svc.from("app_settings").select("value").eq("key", "agent_worker").maybeSingle();
  return NextResponse.json({
    worker: (worker as { value?: unknown } | null)?.value ?? null,
    proposals,
    pending: proposals.filter((p: { status: string }) => p.status === "pending").length,
    lastScan: (lastScan as { value?: unknown } | null)?.value ?? null,
  });
}
