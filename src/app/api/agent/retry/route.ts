import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { agentAccess, canAct } from "@/lib/agent-access";
import { isLiveClaim, proposeForConversation, type Proposal } from "@/lib/agent";
import { resolveClientByHint, resolveClientLocation } from "@/lib/agent-exec";

export const maxDuration = 60; // re-reads the chat and plans again

/* "Correct & retry" (owner request 2026-10-15): the AI misread a request or
   could not find the client's sub-account. The owner types a note on the
   card — who the client is, what to do instead — and the chat is planned
   again WITH that note as authoritative context. A new pending card comes
   back; nothing runs until Approve on it. Works on failed, denied,
   needs-teammate and still-pending cards; never on one the Mac Mini is
   doing right now. Admin only. */
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const svc = createServiceClient();
  // Admins, and coaches for their own clients (src/lib/agent-access.ts).
  const access = await agentAccess(svc, user);
  if (!access) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { id?: string; note?: string };
  const id = String(body.id ?? "").trim();
  const note = String(body.note ?? "").replace(/\s+\n/g, "\n").trim().slice(0, 1500);
  if (!id || note.length < 3) return NextResponse.json({ error: "Write the AI a note first" }, { status: 400 });

  const { data: row } = await svc.from("agent_proposals").select("*").eq("id", id).maybeSingle();
  if (!row) return NextResponse.json({ error: "Card not found" }, { status: 404 });
  if (!canAct(access, row as { contact_name?: string | null; action_detail?: string | null; action_type?: string | null; client_message?: string | null })) return NextResponse.json({ error: "Only the owner can retry this card" }, { status: 403 });
  const p = row as Proposal;
  if (p.status === "queued_browser" || p.status === "running") return NextResponse.json({ error: "The Mac Mini is on this one — wait for it to finish" }, { status: 409 });
  if (p.status === "pending" && isLiveClaim(p)) return NextResponse.json({ error: "Already being approved — refresh in a moment" }, { status: 409 });
  const by = user.email ?? user.id;

  try {
    // Typed team tasks and setup steps have no chat to re-read: the note
    // becomes part of the task itself, and may name the client we missed.
    if (p.conversation_id.startsWith("task:") || p.conversation_id.startsWith("setup:")) {
      let locationId = p.location_id ?? null;
      let contactName = p.contact_name;
      let contactId = p.contact_id;
      if (!locationId) {
        const loc: { locationId: string; ownerName: string; contactId?: string | null } | null =
          (await resolveClientLocation(svc, p.contact_id, p.contact_name).catch(() => null)) ?? (await resolveClientByHint(svc, note).catch(() => null));
        if (loc) { locationId = loc.locationId; contactName = loc.ownerName || contactName; contactId = contactId ?? loc.contactId ?? null; }
      }
      const newId = randomUUID();
      const task = `${p.action_detail ?? p.summary}\n\nOwner's note: ${note}`;
      const { data, error } = await svc.from("agent_proposals").insert({
        conversation_id: `task:${newId}`, message_id: newId, contact_id: contactId, contact_name: contactName, channel: null,
        client_message: `${p.client_message}\n\nOwner's note (${by}): ${note}`,
        summary: p.summary, action_type: "account_change", proposed_reply: null,
        action_detail: task, action_plan: [{ type: "manual", what: task }], location_id: locationId,
        owner_note: note, retry_of: p.id,
      }).select("*").maybeSingle();
      if (error || !data) return NextResponse.json({ error: error?.message ?? "could not save" }, { status: 500 });
      await svc.from("agent_proposals").update({
        ...(p.status === "pending" ? { status: "handled", decided_by: by, decided_at: new Date().toISOString() } : {}),
        result: `${(p.result ?? "").trim()}${p.result ? "\n" : ""}↻ re-planned with your note`.trim(),
      }).eq("id", p.id);
      return NextResponse.json({ proposal: data });
    }

    const r = await proposeForConversation({
      conversationId: p.conversation_id, contactId: p.contact_id, contactName: p.contact_name, channel: p.channel,
      requestedBy: by, fresh: true, ownerNote: note, retryOf: p.id,
    });
    if (r.error || !r.proposal) return NextResponse.json({ error: r.error ?? "failed" }, { status: 502 });
    return NextResponse.json({ proposal: r.proposal });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
