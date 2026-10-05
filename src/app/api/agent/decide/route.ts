import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { waitUntil } from "@vercel/functions";
import { claimCutoff, executeProposal, isLiveClaim, NothingSentError, type Proposal } from "@/lib/agent";
import { sanitizePlan } from "@/lib/agent-exec";
import { recordApprovedReply, settleDashboardSend } from "@/lib/reply-learning";

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

  const body = (await req.json().catch(() => ({}))) as {
    id?: string; decision?: string; reply?: string;
    // Payment-link amounts / label as edited on the card (re-checked here).
    links?: { label?: string; amounts_cents?: number[] };
  };
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
  // Edited payment links replace the planned ones — same limits as the AI's.
  if (body.links && (p.action_plan ?? []).some((s) => s.type === "payment_links")) {
    const old = (p.action_plan ?? []).find((s) => s.type === "payment_links");
    const [edited] = sanitizePlan([{ ...old, type: "payment_links", label: body.links.label ?? (old as { label?: string })?.label, amounts_cents: body.links.amounts_cents, links: undefined }]);
    if (!edited) {
      await svc.from("agent_proposals").update({ decided_by: null, decided_at: null }).eq("id", id).eq("status", "pending");
      return NextResponse.json({ error: "Payment amounts must be $1–$10,000 each, up to 6 links" }, { status: 400 });
    }
    p.action_plan = (p.action_plan ?? []).map((s) => (s.type === "payment_links" ? edited : s));
  }
  try {
    const out = await executeProposal(p, reply, decidedBy);
    // Learn from it: the AI's draft vs what the approver actually sent.
    // The card's drafts are closed (the thread would credit this text to
    // whoever drafted it) and one lesson is saved in the approver's voice.
    if (reply?.trim() && out.result.startsWith("reply sent")) {
      waitUntil((async () => {
        await settleDashboardSend({ conversationId: p.conversation_id, sent: reply, senderEmail: user.email ?? "", pairOwnDraft: false });
        if (p.proposed_reply) {
          await recordApprovedReply({
            conversationId: p.conversation_id, contactId: p.contact_id, contactName: p.contact_name,
            aiDraft: p.proposed_reply, sent: reply, approverEmail: user.email ?? "",
          });
        }
      })().catch(() => undefined));
    }
    return NextResponse.json({ success: out.status !== "failed", ...out });
  } catch (e) {
    // Square refused the payment links before anything was sent: release the
    // claim so the card can be approved again (same links — idempotent).
    if (e instanceof NothingSentError) {
      await svc.from("agent_proposals").update({ decided_by: null, decided_at: null }).eq("id", id).eq("status", "pending").is("executed_at", null);
      return NextResponse.json({ error: e.message }, { status: 502 });
    }
    // We can't know whether the reply went out — never re-arm Approve (that
    // could text the client twice). Close it as failed; 🪄 can plan again.
    const msg = e instanceof Error ? e.message : "failed";
    await svc.from("agent_proposals").update({
      status: "failed", result: `✗ ${msg} — check the chat before trying again`, executed_at: new Date().toISOString(),
    }).eq("id", id).eq("status", "pending");
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
