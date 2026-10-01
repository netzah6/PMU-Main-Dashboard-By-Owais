import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { claimCutoff, executeProposal, isLiveClaim, type Proposal } from "@/lib/agent";

export const maxDuration = 60; // approve now also runs the account change against GHL

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

  // An earlier Approve already sent the reply and then died (timeout) before
  // finishing. Never send it again — close it so a person finishes by hand.
  if (p.executed_at) {
    if (!isLiveClaim(p)) {
      await svc.from("agent_proposals").update({
        status: "failed", result: "✗ reply was already sent, but the run stopped before finishing — check the account and finish by hand",
      }).eq("id", id).eq("status", "pending");
      return NextResponse.json({ error: "Reply was already sent — finish this one by hand" }, { status: 409 });
    }
    return NextResponse.json({ error: "Already being approved — refresh in a moment" }, { status: 409 });
  }

  const decidedBy = user.email ?? user.id;
  // Claim the card before doing anything. The status only changes after the
  // reply is sent (10–60 s), so without this a second Approve (another tab,
  // another admin, a card re-opened mid-run) texted the client twice. A
  // claim older than CLAIM_TTL_MS is a run that died (timeout) and may retry.
  const { data: claimed } = await svc.from("agent_proposals")
    .update({ decided_by: decidedBy, decided_at: new Date().toISOString() })
    .eq("id", id).eq("status", "pending").is("executed_at", null)
    .or(`decided_at.is.null,decided_at.lt."${claimCutoff()}"`)
    .select("id").maybeSingle();
  if (!claimed) return NextResponse.json({ error: "Already being approved — refresh in a moment" }, { status: 409 });

  if (decision === "deny") {
    await svc.from("agent_proposals").update({
      status: "denied", decided_by: decidedBy, decided_at: new Date().toISOString(), result: "denied — nothing sent or changed",
    }).eq("id", id);
    return NextResponse.json({ success: true, status: "denied" });
  }

  const reply = body.reply !== undefined ? String(body.reply) : p.proposed_reply;
  try {
    const out = await executeProposal(p, reply, decidedBy);
    return NextResponse.json({ success: out.status !== "failed", ...out });
  } catch (e) {
    // We can't know whether the reply went out — never re-arm Approve (that
    // could text the client twice). Close it as failed; 🪄 can plan again.
    const msg = e instanceof Error ? e.message : "failed";
    await svc.from("agent_proposals").update({
      status: "failed", result: `✗ ${msg} — check the chat before trying again`, executed_at: new Date().toISOString(),
    }).eq("id", id).eq("status", "pending");
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
