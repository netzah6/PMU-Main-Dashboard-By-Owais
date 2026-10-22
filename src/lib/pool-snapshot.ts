import type { SupabaseClient } from "@supabase/supabase-js";
import { refreshPoolCleanliness } from "@/lib/ghl-cleanup";

/* ── Snapshot reload for recycled pool accounts (owner, 10/15/2026) ─────────
   The Cleanup wipe deletes a sub-account's custom values, custom fields and
   calendars; the GHL API cannot load a snapshot onto an existing location.
   So finalize queues ONE task for the 24/7 AI Agent browser worker: load the
   newest "Demo (V2/V3) Snapshop …" snapshot from the agency Sub-Accounts
   screen and verify the custom values + template workflows are back. The
   account is offered for a New Client Setup only after that task is done.

   The task is an agent_proposals row with
     conversation_id = 'pool:<location id>:snapshot_load'
   (same shape as the setup run's 'setup:<card>:<step>' rows — the worker's
   finish hook parses the prefix). The plan text is the one that ran for
   Sally Nails And Spa (card 151b63a5…), parameterised by account. */

type Svc = SupabaseClient;
const now = () => new Date().toISOString();
const usDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });

export const SNAPSHOT_PREFIX = "pool:";
export const SNAPSHOT_KEY = "snapshot_load";
export const SNAPSHOT_NAME_HINT = 'Demo (V2/V3) Snapshop';
export const snapshotConvId = (locationId: string) => `${SNAPSHOT_PREFIX}${locationId}:${SNAPSHOT_KEY}`;
export function parseSnapshotConvId(conversationId: string | null | undefined): { locationId: string } | null {
  if (!conversationId?.startsWith(SNAPSHOT_PREFIX)) return null;
  const [, locationId, key] = conversationId.split(":");
  return locationId && key === SNAPSHOT_KEY ? { locationId } : null;
}

// The Mac Mini's steps — read-only verification apart from the load itself.
export function snapshotLoadPlan(locationId: string, poolName: string): string[] {
  return [
    `Switch to the AGENCY view (top-left account switcher → agency "PMU Bookings On Demand"), then open Sub-Accounts: https://app.gohighlevel.com/agency_dashboard/ → left menu Sub-Accounts.`,
    `Find the sub-account named "${poolName}" (location id ${locationId}). Open its Actions (⋮ or the Manage/Actions menu on the row) and choose "Load Snapshot".`,
    `In the snapshot picker choose the NEWEST snapshot whose name starts with "${SNAPSHOT_NAME_HINT}" (date suffix varies, e.g. 3/7/26). Keep the default options, confirm/Proceed. Screenshot the picker with the chosen snapshot name visible, and the confirmation.`,
    `Once GHL says the snapshot is being pushed, you are done with the load. Do NOT load it a second time. GHL applies it over several minutes, and the account is only usable once ALL of it is in (Brows by Susan, 10/22/2026: a half-applied load had no calendar). Wait 3 minutes, then open Calendars: https://app.gohighlevel.com/v2/location/${locationId}/settings/calendars and check that a calendar named "Permanent Makeup Transformation" is listed. If it is not there yet, wait 3 more minutes and look again, up to 4 looks in all. Take ONE screenshot of the final look ("after-1.png"). Calendar listed → report status done. Still missing after the 4th look → report status done with the summary "load triggered, GHL still applying it" — the dashboard verifies the account itself.`,
    `If "Load Snapshot" is not offered to this user or the snapshot name is not found, stop and report exactly what the screen shows (status needs_teammate).`,
  ];
}

export type QueueResult = { taskId: string; reused: boolean };

/* Queue the load for one pool account. A card already open for it
   (queued / running) is reused, so a second finalize or a nervous click on
   "Load snapshot" never puts the Mini on the same account twice. */
export async function queueSnapshotLoad(svc: Svc, args: { locationId: string; poolName: string; by: string; reason?: string }): Promise<QueueResult> {
  const conversationId = snapshotConvId(args.locationId);
  const { data: existing } = await svc.from("agent_proposals").select("id, status")
    .eq("conversation_id", conversationId).in("status", ["queued_browser", "running"]).limit(1).maybeSingle();
  if (existing) {
    await markQueued(svc, args.locationId, (existing as { id: string }).id, "already queued");
    return { taskId: (existing as { id: string }).id, reused: true };
  }

  const { count } = await svc.from("agent_proposals").select("id", { count: "exact", head: true }).eq("conversation_id", conversationId);
  const attempt = (count ?? 0) + 1;
  const reason = args.reason ?? "was wiped by the Cleanup and renamed into the clean-account pool";
  const { data: ins, error } = await svc.from("agent_proposals").insert({
    conversation_id: conversationId,
    message_id: `${SNAPSHOT_KEY}#${attempt}`,
    contact_id: null,
    contact_name: args.poolName,
    channel: null,
    client_message: `Clean-account pool: load the Demo snapshot onto ${args.poolName} (${args.locationId}). It ${reason} on ${usDate(now())}. Without the snapshot the account has no custom values, fields or workflows, and a new client setup on it fails. Queued by ${args.by}.`,
    summary: `Pool: load the snapshot onto ${args.poolName} (custom values, fields and workflows were wiped)`.slice(0, 500),
    action_type: "account_change",
    proposed_reply: null,
    action_detail: `This sub-account (${args.poolName}) ${reason} and has no snapshot. Load the current ${SNAPSHOT_NAME_HINT} snapshot onto it so the custom values, custom fields, workflows, funnels and calendars exist again. The dashboard offers it for a new client setup only after this is done.`.slice(0, 1500),
    action_plan: snapshotLoadPlan(args.locationId, args.poolName).map((what) => ({ type: "manual", what })),
    location_id: args.locationId,
    status: "queued_browser",
    decided_by: `${args.by} (cleanup finalize)`,
    decided_at: now(),
    executed_at: now(),
    result: "⏳ Waiting for the AI Agent (snapshot load)",
  }).select("id").maybeSingle();
  if (error || !ins) throw new Error(`could not queue the snapshot task: ${error?.message ?? "insert failed"}`);
  const taskId = (ins as { id: string }).id;
  await markQueued(svc, args.locationId, taskId, attempt > 1 ? `queued again for the AI Agent (try ${attempt})` : "queued for the AI Agent");
  return { taskId, reused: false };
}

async function markQueued(svc: Svc, locationId: string, taskId: string, note: string): Promise<void> {
  await svc.from("pool_accounts").update({
    snapshot_task_id: taskId, snapshot_queued_at: now(), snapshot_loaded_at: null, snapshot_note: note,
  }).eq("location_id", locationId);
  await svc.from("cleanup_log").update({ snapshot_task_id: taskId, snapshot_loaded_at: null }).eq("location_id", locationId);
}

/* The wipe ran again on an account that is (or was) in the pool: whatever
   snapshot it had is gone, so it goes back to "waiting for snapshot". */
export async function clearSnapshotMark(svc: Svc, locationId: string): Promise<void> {
  await svc.from("pool_accounts").update({ snapshot_loaded_at: null, snapshot_note: `wiped ${usDate(now())} — the snapshot must be loaded again` })
    .eq("location_id", locationId);
  await svc.from("cleanup_log").update({ snapshot_loaded_at: null }).eq("location_id", locationId);
}

/* Called by the worker when a snapshot card closes. Done → the account is
   marked loaded and re-inspected right away, so the pool shows what the
   API actually sees (a load GHL is still applying stays "waiting" until
   the next Re-check). Failed / needs a teammate → the reason on the row,
   with a Load-snapshot button in the Cleanup tab to queue it again. */
export async function onSnapshotProposalClosed(svc: Svc, p: { id: string; conversation_id: string; status: string; result: string | null }): Promise<void> {
  const ref = parseSnapshotConvId(p.conversation_id);
  if (!ref) return;
  const { data: row } = await svc.from("pool_accounts").select("snapshot_task_id").eq("location_id", ref.locationId).maybeSingle();
  const current = (row as { snapshot_task_id?: string | null } | null)?.snapshot_task_id;
  if (current && current !== p.id) return; // an older card for a re-queued account
  const firstLine = String(p.result ?? "").split("\n")[0].replace(/^[✓✗👤]\s*/, "").slice(0, 200);
  if (p.status === "done") {
    const at = now();
    await svc.from("pool_accounts").update({ snapshot_loaded_at: at, snapshot_note: `loaded by the AI Agent ${usDate(at)}` }).eq("location_id", ref.locationId);
    await svc.from("cleanup_log").update({ snapshot_loaded_at: at }).eq("location_id", ref.locationId);
    try { await refreshPoolCleanliness([ref.locationId]); } catch { /* the next Re-check verifies it */ }
    return;
  }
  // The worker can run out of turns AFTER the load went through (Clean New
  // Account 79, 10/21/2026): look at the account before calling it failed.
  try {
    const [live] = await refreshPoolCleanliness([ref.locationId]);
    if (live?.snapshot_loaded_at) {
      await svc.from("pool_accounts").update({ snapshot_task_id: null, snapshot_note: `loaded (seen by the Re-check after the AI Agent stopped early) ${usDate(now())}` }).eq("location_id", ref.locationId);
      await svc.from("cleanup_log").update({ snapshot_loaded_at: live.snapshot_loaded_at }).eq("location_id", ref.locationId);
      return;
    }
  } catch { /* fall through to the failure note */ }
  const why = p.status === "needs_teammate" ? "the AI Agent needs a teammate" : "the AI Agent could not finish";
  await svc.from("pool_accounts").update({ snapshot_loaded_at: null, snapshot_note: `✗ ${why}: ${firstLine}`.slice(0, 300) }).eq("location_id", ref.locationId);
}
