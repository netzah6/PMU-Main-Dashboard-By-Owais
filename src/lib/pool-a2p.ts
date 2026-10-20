import type { SupabaseClient } from "@supabase/supabase-js";

/* ── A2P verification for the clean-account pool (owner, 10/20/2026) ───────
   GHL's API does not expose A2P / 10DLC status, so the pool's `a2p` flag was
   set by hand (chip toggle) or carried over by the Cleanup wipe — and never
   re-verified. Now the AI Agent browser worker opens each pool account's
   Trust Center page, reads the brand + campaign status, and the flag follows
   what it saw. One task per account:
     conversation_id = 'pool:<location id>:a2p_check'
   Queued by the weekly cron (/api/cron/a2p-sweep), the "Verify A2P" button
   in the Cleanup tab, or per account. The task's report must end with the
   line "A2P: APPROVED" or "A2P: NOT APPROVED — <what the screen shows>". */

type Svc = SupabaseClient;
const now = () => new Date().toISOString();
const usDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });

export const A2P_PREFIX = "pool:";
export const A2P_KEY = "a2p_check";
export const A2P_BY = "AI Agent";
export const a2pConvId = (locationId: string) => `${A2P_PREFIX}${locationId}:${A2P_KEY}`;
export function parseA2pConvId(conversationId: string | null | undefined): { locationId: string } | null {
  if (!conversationId?.startsWith(A2P_PREFIX)) return null;
  const [, locationId, key] = conversationId.split(":");
  return locationId && key === A2P_KEY ? { locationId } : null;
}

// Read-only: nothing on the Trust Center page is clicked except tabs.
export function a2pCheckPlan(locationId: string, poolName: string): string[] {
  return [
    `Open https://app.gohighlevel.com/v2/location/${locationId}/settings/phone_number and go to the "Trust Center" tab (A2P / 10DLC registration) for the sub-account "${poolName}". Do not change anything.`,
    `Read the Brand registration status and the Campaign (A2P 10DLC) status. Screenshot the page with both statuses visible.`,
    `Report. The LAST line of your report must be exactly one of: "A2P: APPROVED" (both brand and campaign show Approved / Verified / Registered, green) or "A2P: NOT APPROVED — <copy the status words the screen shows, e.g. Pending, Rejected, Not registered, No campaign>".`,
    `If the page does not load or the Trust Center tab is missing, end with "A2P: NOT APPROVED — could not read: <what you saw>" and status needs_teammate.`,
  ];
}

export type QueueResult = { taskId: string; reused: boolean };

/* Queue the check for one pool account; an open card for it is reused. */
export async function queueA2pCheck(svc: Svc, args: { locationId: string; poolName: string; by: string }): Promise<QueueResult> {
  const conversationId = a2pConvId(args.locationId);
  const { data: existing } = await svc.from("agent_proposals").select("id")
    .eq("conversation_id", conversationId).in("status", ["queued_browser", "running"]).limit(1).maybeSingle();
  if (existing) {
    const id = (existing as { id: string }).id;
    await svc.from("pool_accounts").update({ a2p_task_id: id, a2p_queued_at: now() }).eq("location_id", args.locationId);
    return { taskId: id, reused: true };
  }
  const { count } = await svc.from("agent_proposals").select("id", { count: "exact", head: true }).eq("conversation_id", conversationId);
  const attempt = (count ?? 0) + 1;
  const { data: ins, error } = await svc.from("agent_proposals").insert({
    conversation_id: conversationId,
    message_id: `${A2P_KEY}#${attempt}`,
    contact_id: null,
    contact_name: args.poolName,
    channel: null,
    client_message: `Clean-account pool: verify A2P on ${args.poolName} (${args.locationId}). Read-only check of the Trust Center status, queued by ${args.by} on ${usDate(now())}.`,
    summary: `Pool: verify A2P on ${args.poolName} (read the Trust Center status)`.slice(0, 500),
    action_type: "account_change",
    proposed_reply: null,
    action_detail: `Read the A2P / 10DLC brand and campaign status of ${args.poolName} in GoHighLevel's Trust Center and report it. Change nothing. The dashboard colours the pool chip from this answer.`.slice(0, 1500),
    action_plan: a2pCheckPlan(args.locationId, args.poolName).map((what) => ({ type: "manual", what })),
    location_id: args.locationId,
    status: "queued_browser",
    decided_by: `${args.by} (A2P check)`,
    decided_at: now(),
    executed_at: now(),
    result: "⏳ Waiting for the AI Agent (A2P check)",
  }).select("id").maybeSingle();
  if (error || !ins) throw new Error(`could not queue the A2P check: ${error?.message ?? "insert failed"}`);
  const taskId = (ins as { id: string }).id;
  await svc.from("pool_accounts").update({ a2p_task_id: taskId, a2p_queued_at: now() }).eq("location_id", args.locationId);
  return { taskId, reused: false };
}

/* Every available pool account (the weekly sweep and the tab's button).
   `olderThanDays` skips accounts the agent verified recently. */
export async function queueA2pSweep(svc: Svc, by: string, olderThanDays = 0): Promise<{ queued: number; reused: number; skipped: number }> {
  const { data } = await svc.from("pool_accounts").select("location_id, pool_name, a2p_updated_at, a2p_updated_by").eq("status", "available");
  const rows = (data ?? []) as Array<{ location_id: string; pool_name: string; a2p_updated_at: string | null; a2p_updated_by: string | null }>;
  const cutoff = Date.now() - olderThanDays * 86_400_000;
  const out = { queued: 0, reused: 0, skipped: 0 };
  for (const r of rows) {
    const fresh = olderThanDays > 0 && r.a2p_updated_by === A2P_BY && r.a2p_updated_at && Date.parse(r.a2p_updated_at) > cutoff;
    if (fresh) { out.skipped++; continue; }
    const q = await queueA2pCheck(svc, { locationId: r.location_id, poolName: r.pool_name, by });
    if (q.reused) out.reused++; else out.queued++;
  }
  return out;
}

/* The worker closed an A2P card: the flag follows the report's last
   "A2P: …" line. An unreadable report keeps the old flag and says so. */
export async function onA2pProposalClosed(svc: Svc, p: { id: string; conversation_id: string; status: string; result: string | null }): Promise<void> {
  const ref = parseA2pConvId(p.conversation_id);
  if (!ref) return;
  const { data: row } = await svc.from("pool_accounts").select("a2p_task_id").eq("location_id", ref.locationId).maybeSingle();
  const current = (row as { a2p_task_id?: string | null } | null)?.a2p_task_id;
  if (current && current !== p.id) return; // an older card for a re-queued account
  const text = String(p.result ?? "");
  const verdicts = [...text.matchAll(/A2P:\s*(NOT APPROVED|APPROVED)\b\s*[—\-–:]?\s*([^\n]*)/gi)];
  const last = verdicts[verdicts.length - 1];
  const at = now();
  if (last) {
    const approved = last[1].toUpperCase() === "APPROVED";
    const detail = last[2].trim();
    await svc.from("pool_accounts").update({
      a2p: approved ? "approved" : "pending", a2p_updated_at: at, a2p_updated_by: A2P_BY, a2p_task_id: null,
      a2p_note: `${approved ? "✓ approved" : "✗ not approved"}${detail ? ` — ${detail}` : ""} (AI Agent ${usDate(at)})`.slice(0, 300),
    }).eq("location_id", ref.locationId);
    return;
  }
  const firstLine = text.split("\n")[0].replace(/^[✓✗👤]\s*/, "").slice(0, 200);
  const why = p.status === "done" ? "no clear answer" : p.status === "needs_teammate" ? "the AI Agent needs a teammate" : "the AI Agent could not finish";
  await svc.from("pool_accounts").update({ a2p_task_id: null, a2p_note: `? not verified — ${why}: ${firstLine} (${usDate(at)})`.slice(0, 300) }).eq("location_id", ref.locationId);
}
