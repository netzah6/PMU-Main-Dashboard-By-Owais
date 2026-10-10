import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";

// The CEO agent's proposal inbox — admin only.
export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const svc = createServiceClient();
  const { data: roleRow } = await svc.from("user_roles").select("role").eq("user_id", user.id).maybeSingle();
  if ((roleRow as { role?: string } | null)?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden — admin only" }, { status: 403 });
  }

  const { data, error } = await svc
    .from("agent_proposals")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(60);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const proposals = data ?? [];
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
