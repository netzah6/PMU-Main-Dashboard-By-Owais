import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { executeProposal, type Proposal } from "@/lib/agent";

export const maxDuration = 30;

// Approve / deny one agent proposal — admin only. Approve sends the (possibly
// edited) reply and, for account changes, queues the browser-worker job.
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const svc = createServiceClient();
  const { data: roleRow } = await svc.from("user_roles").select("role").eq("user_id", user.id).maybeSingle();
  if ((roleRow as { role?: string } | null)?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden — admin only" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { id?: string; decision?: string; reply?: string };
  const id = String(body.id ?? "").trim();
  const decision = String(body.decision ?? "");
  if (!id || !["approve", "deny"].includes(decision)) {
    return NextResponse.json({ error: "id and decision (approve|deny) required" }, { status: 400 });
  }

  const { data: row } = await svc.from("agent_proposals").select("*").eq("id", id).maybeSingle();
  if (!row) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
  const p = row as Proposal;
  if (p.status !== "pending") return NextResponse.json({ error: `Already ${p.status}` }, { status: 409 });

  const decidedBy = user.email ?? user.id;
  if (decision === "deny") {
    await svc.from("agent_proposals").update({
      status: "denied", decided_by: decidedBy, decided_at: new Date().toISOString(), result: "denied — nothing sent or changed",
    }).eq("id", id);
    return NextResponse.json({ success: true, status: "denied" });
  }

  const reply = body.reply !== undefined ? String(body.reply) : p.proposed_reply;
  const out = await executeProposal(p, reply, decidedBy);
  return NextResponse.json({ success: out.status !== "failed", ...out });
}
