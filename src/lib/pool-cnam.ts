import type { SupabaseClient } from "@supabase/supabase-js";

/* ── CNAM reset for the clean-account pool (owner, 10/21/2026) ─────────────
   A recycled sub-account keeps the previous clients' approved caller names
   (CNAM) in its Trust Center. That disables "Start Registration", so the new
   client's CNAM step cannot submit "PermanentMakeup" (Sudbury Med Spa on
   Clean New Account 79). GHL's UI has no delete for a CNAM — only GHL
   support can remove it. So:
     • every wipe (Cleanup finalize) queues ONE AI Agent task per account:
       read the CNAMs; if any name is not "PermanentMakeup", open the GHL
       support chat and ask for their removal;
     • the weekly sweep re-checks accounts marked "requested" until the old
       names are gone (and nudges the same support conversation).
   Task: agent_proposals row, conversation_id = 'pool:<location id>:cnam_check'.
   The report's LAST line must be one of:
     "CNAM: OK"                               nothing foreign on the account
     "CNAM: REQUESTED — <old names>"          support asked (or nudged)
     "CNAM: STALE — <old names> (<why>)"      old names there, no request possible */

type Svc = SupabaseClient;
const now = () => new Date().toISOString();
const usDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });

export const CNAM_PREFIX = "pool:";
export const CNAM_KEY = "cnam_check";
export const CNAM_BY = "AI Agent";
export const WANTED_CNAM = "PermanentMakeup";
export const cnamConvId = (locationId: string) => `${CNAM_PREFIX}${locationId}:${CNAM_KEY}`;
export function parseCnamConvId(conversationId: string | null | undefined): { locationId: string } | null {
  if (!conversationId?.startsWith(CNAM_PREFIX)) return null;
  const [, locationId, key] = conversationId.split(":");
  return locationId && key === CNAM_KEY ? { locationId } : null;
}

/* The message the AI Agent sends to GHL support. Plain, complete, one shot. */
export function cnamSupportMessage(locationId: string, accountName: string, oldNames: string): string {
  return `Hi! Sub-account "${accountName}" (location ID ${locationId}) has CNAM (caller name) registrations approved under names that belong to previous businesses: ${oldNames}. Please remove / deregister those CNAM registrations from this sub-account's business profile so we can register the caller name "${WANTED_CNAM}" for its number. "Start Registration" is currently disabled because of them. Thank you!`;
}

export function cnamCheckPlan(locationId: string, accountName: string, opts: { requestedOn?: string | null } = {}): string[] {
  const steps = [
    `Open https://app.gohighlevel.com/v2/location/${locationId}/settings/phone_number and go to the "Trust Center" tab for the sub-account "${accountName}". Find the CNAM (Caller Name) registration and open "View Details". Screenshot the list of registered caller names ("before-1.png").`,
    `If the only registered caller name is "${WANTED_CNAM}", or there is no CNAM registration at all and "Start Registration" is enabled, change nothing and end your report with "CNAM: OK".`,
  ];
  if (opts.requestedOn) {
    steps.push(
      `We already asked GoHighLevel support on ${usDate(opts.requestedOn)} to remove the old names. If other names are STILL listed: open the support chat (the "?" / Help icon → Contact Support / chat), find that conversation, and send one short follow-up: "Following up on the CNAM removal for sub-account ${accountName} (location ID ${locationId}) — can you confirm when the old caller names are removed? Thank you." Screenshot it ("after-1.png") and end with "CNAM: REQUESTED — <the old names still listed>".`,
    );
  } else {
    steps.push(
      `If other caller names are listed (e.g. previous businesses): open the GoHighLevel support chat — the "?" / Help icon → "Contact Support" / "Chat with us" (in the agency view if the sub-account view has none) — start a new conversation and send exactly this message:\n"${cnamSupportMessage(locationId, accountName, "<the old names, comma separated>")}"\nYou MAY send this one message to GoHighLevel support; it is the task. Screenshot the sent message ("after-1.png") and end your report with "CNAM: REQUESTED — <the old names>".`,
    );
  }
  steps.push(
    `If the support chat cannot be opened or the message cannot be sent, change nothing and end with "CNAM: STALE — <the old names> (<what stopped you>)". Never delete anything yourself.`,
  );
  return steps;
}

export type QueueResult = { taskId: string; reused: boolean };

export async function queueCnamCheck(svc: Svc, args: { locationId: string; poolName: string; by: string; requestedOn?: string | null }): Promise<QueueResult> {
  const conversationId = cnamConvId(args.locationId);
  const { data: existing } = await svc.from("agent_proposals").select("id")
    .eq("conversation_id", conversationId).in("status", ["queued_browser", "running"]).limit(1).maybeSingle();
  if (existing) {
    const id = (existing as { id: string }).id;
    await svc.from("pool_accounts").update({ cnam_task_id: id, cnam_queued_at: now() }).eq("location_id", args.locationId);
    return { taskId: id, reused: true };
  }
  const { count } = await svc.from("agent_proposals").select("id", { count: "exact", head: true }).eq("conversation_id", conversationId);
  const attempt = (count ?? 0) + 1;
  const followUp = !!args.requestedOn;
  const { data: ins, error } = await svc.from("agent_proposals").insert({
    conversation_id: conversationId,
    message_id: `${CNAM_KEY}#${attempt}`,
    contact_id: null,
    contact_name: args.poolName,
    channel: null,
    client_message: `Clean-account pool: ${followUp ? "check back on" : "reset"} the caller name (CNAM) of ${args.poolName} (${args.locationId}). A recycled account keeps the previous clients' CNAMs, which blocks the new client's "${WANTED_CNAM}" registration. Queued by ${args.by} on ${usDate(now())}.`,
    summary: `Pool: ${followUp ? "CNAM check-back" : "CNAM reset"} on ${args.poolName} (old caller names → ask GHL support)`.slice(0, 500),
    action_type: "account_change",
    proposed_reply: null,
    action_detail: `Read the Trust Center CNAM registrations of ${args.poolName}. Only "${WANTED_CNAM}" may stay; any other name is a previous client's and GoHighLevel support must remove it — ${followUp ? "follow up in the existing support conversation" : "ask them in the support chat"}. Change nothing else.`.slice(0, 1500),
    action_plan: cnamCheckPlan(args.locationId, args.poolName, { requestedOn: args.requestedOn }).map((what) => ({ type: "manual", what })),
    location_id: args.locationId,
    status: "queued_browser",
    decided_by: `${args.by} (CNAM ${followUp ? "check-back" : "reset"})`,
    decided_at: now(),
    executed_at: now(),
    result: "⏳ Waiting for the AI Agent (CNAM check)",
  }).select("id").maybeSingle();
  if (error || !ins) throw new Error(`could not queue the CNAM check: ${error?.message ?? "insert failed"}`);
  const taskId = (ins as { id: string }).id;
  await svc.from("pool_accounts").update({ cnam_task_id: taskId, cnam_queued_at: now() }).eq("location_id", args.locationId);
  return { taskId, reused: false };
}

/* Weekly: every available account never checked, still "stale", or
   "requested" (support asked, old names maybe gone by now). */
export async function queueCnamSweep(svc: Svc, by: string): Promise<{ queued: number; reused: number; skipped: number }> {
  const { data } = await svc.from("pool_accounts").select("location_id, pool_name, cnam_status, cnam_updated_at").eq("status", "available");
  const rows = (data ?? []) as Array<{ location_id: string; pool_name: string; cnam_status: string | null; cnam_updated_at: string | null }>;
  const out = { queued: 0, reused: 0, skipped: 0 };
  for (const r of rows) {
    if (r.cnam_status === "ok") { out.skipped++; continue; }
    const q = await queueCnamCheck(svc, { locationId: r.location_id, poolName: r.pool_name, by, requestedOn: r.cnam_status === "requested" ? r.cnam_updated_at : null });
    if (q.reused) out.reused++; else out.queued++;
  }
  return out;
}

/* The worker closed a CNAM card: the pool row follows the report's last "CNAM: …" line. */
export async function onCnamProposalClosed(svc: Svc, p: { id: string; conversation_id: string; status: string; result: string | null }): Promise<void> {
  const ref = parseCnamConvId(p.conversation_id);
  if (!ref) return;
  const { data: row } = await svc.from("pool_accounts").select("cnam_task_id, cnam_status, cnam_updated_at").eq("location_id", ref.locationId).maybeSingle();
  const cur = row as { cnam_task_id?: string | null; cnam_status?: string | null; cnam_updated_at?: string | null } | null;
  if (cur?.cnam_task_id && cur.cnam_task_id !== p.id) return; // an older card for a re-queued account
  const text = String(p.result ?? "");
  const verdicts = [...text.matchAll(/CNAM:\s*(OK|REQUESTED|STALE)\b\s*[—\-–:]?\s*([^\n]*)/gi)];
  const last = verdicts[verdicts.length - 1];
  const at = now();
  if (last) {
    const verdict = last[1].toUpperCase();
    const detail = last[2].trim();
    const status = verdict === "OK" ? "ok" : verdict === "REQUESTED" ? "requested" : "stale";
    // Keep the first request date so the check-back knows how long it has been.
    const keepDate = status === "requested" && cur?.cnam_status === "requested" && cur.cnam_updated_at;
    await svc.from("pool_accounts").update({
      cnam_status: status, cnam_task_id: null, cnam_updated_at: keepDate ? cur!.cnam_updated_at : at,
      cnam_note: `${status === "ok" ? "✓ caller name OK" : status === "requested" ? "⏳ GHL support asked to remove" : "✗ old caller names, no request made"}${detail ? ` — ${detail}` : ""} (AI Agent ${usDate(at)})`.slice(0, 300),
    }).eq("location_id", ref.locationId);
    return;
  }
  const firstLine = text.split("\n")[0].replace(/^[✓✗👤]\s*/, "").slice(0, 200);
  const why = p.status === "done" ? "no clear answer" : p.status === "needs_teammate" ? "the AI Agent needs a teammate" : "the AI Agent could not finish";
  await svc.from("pool_accounts").update({ cnam_task_id: null, cnam_note: `? not checked — ${why}: ${firstLine} (${usDate(at)})`.slice(0, 300) }).eq("location_id", ref.locationId);
}
