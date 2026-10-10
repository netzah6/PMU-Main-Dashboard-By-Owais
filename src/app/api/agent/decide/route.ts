import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { claimCutoff, executeProposal, isLiveClaim, NothingSentError, type Proposal } from "@/lib/agent";
import { sanitizePlan } from "@/lib/agent-exec";

export const maxDuration = 60; // approve now also runs the account change against GHL

// Approve / deny one agent proposal — admin only. Approve makes the change in
// the client's account and texts the owner a confirmation. It never texts
// the client (owner, 2026-10-10 — the team replies).
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
        status: "failed", result: "✗ the run stopped before finishing — check the account and finish by hand",
      }).eq("id", id).eq("status", "pending");
      return NextResponse.json({ error: "A previous run stopped part-way — finish this one by hand" }, { status: 409 });
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
    const out = await executeProposal(p, null, decidedBy);
    return NextResponse.json({ success: out.status !== "failed", ...out });
  } catch (e) {
    // Square refused the payment links before anything was sent: release the
    // claim so the card can be approved again (same links — idempotent).
    if (e instanceof NothingSentError) {
      await svc.from("agent_proposals").update({ decided_by: null, decided_at: null }).eq("id", id).eq("status", "pending").is("executed_at", null);
      return NextResponse.json({ error: e.message }, { status: 502 });
    }
    // We can't know how far the change got — never re-arm Approve blindly.
    // Close it as failed; 🪄 can plan again.
    const msg = e instanceof Error ? e.message : "failed";
    await svc.from("agent_proposals").update({
      status: "failed", result: `✗ ${msg} — check the account before trying again`, executed_at: new Date().toISOString(),
    }).eq("id", id).eq("status", "pending");
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
