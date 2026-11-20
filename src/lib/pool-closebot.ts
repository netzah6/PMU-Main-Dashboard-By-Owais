import type { SupabaseClient } from "@supabase/supabase-js";
import { CLOSEBOT_SIGN_IN } from "@/lib/closebot-signin";

/* ── CloseBot off for cleaned accounts (owner, 11/20/2026) ──────────────────
   Cleaning a client's sub-account wipes GoHighLevel, but CloseBot keeps the
   old source attached to its agents with the AI ON. 16 accounts cleaned on
   11/19 still had the slay agent on the next day. When such an account is
   given to a new client, the old source (and its old artist name) would
   answer the new client's leads. Owner: removing the account from CloseBot
   is part of cleaning it.

   So every Cleanup "finalize" queues ONE Mac Mini task per account: open each
   CloseBot agent, find the source whose GoHighLevel location id is THIS
   account (read from the page, never guessed from the name), remove it from
   that agent and publish. The daily CloseBot check is the safety net: a pool
   account still found with the AI on gets the same task again (at most once
   every 3 days), and its alert closes on the next check once it is off.
   Task: agent_proposals row, conversation_id = 'pool:<location id>:closebot_off'.
   The report's LAST line must be one of:
     "CLOSEBOT: REMOVED — <agent names>"
     "CLOSEBOT: NONE"                     no agent had this account
     "CLOSEBOT: STUCK — <why>"            */

type Svc = SupabaseClient;
const now = () => new Date().toISOString();
const usDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });

export const CB_OFF_PREFIX = "pool:";
export const CB_OFF_KEY = "closebot_off";
export const cbOffConvId = (locationId: string) => `${CB_OFF_PREFIX}${locationId}:${CB_OFF_KEY}`;
export function parseCbOffConvId(conversationId: string | null | undefined): { locationId: string } | null {
  if (!conversationId?.startsWith(CB_OFF_PREFIX)) return null;
  const [, locationId, key] = conversationId.split(":");
  return locationId && key === CB_OFF_KEY ? { locationId } : null;
}

/* Run in the agent page with its Sources panel open. Returns only names
   and counts — the source objects also hold access tokens, never print them. */
export function cbOffProbe(locationId: string): string {
  return `(() => { const loc = ${JSON.stringify(locationId)}; for (const el of document.querySelectorAll('span')) { const k = Object.keys(el).find((x) => x.startsWith('__reactFiber')); if (!k) continue; let f = el[k]; for (let i = 0; i < 20 && f; i++, f = f.return) { const s = f.memoizedProps && f.memoizedProps.addedSources; if (Array.isArray(s)) return JSON.stringify({ total: s.length, match: s.filter((x) => x.key === loc).map((x) => x.name) }); } } return 'panel not open'; })()`;
}

export function cbOffPlan(locationId: string, poolName: string, oldNames: string[]): string[] {
  const names = [...new Set(oldNames.map((n) => n.trim()).filter(Boolean))];
  const named = names.length ? ` CloseBot may still call it by the old name: ${names.map((n) => `"${n}"`).join(" or ")}.` : "";
  return [
    `First open https://app.gohighlevel.com/v2/location/${locationId}/dashboard and read the sub-account name at the top left. If it is NOT "${poolName}" (a new client already took this account), change nothing anywhere and end with "CLOSEBOT: STUCK — account now named <name>, in use".`,
    `This account (${poolName}, GoHighLevel location ${locationId}) was cleaned and no longer belongs to a client. Turn its CloseBot AI off: remove it from every CloseBot agent it is attached to, then publish. Change nothing else — no other source, no agent prompt, no settings.${named} ${CLOSEBOT_SIGN_IN}`,
    `Open https://app.closebot.com/bots and note every agent listed (also inside folders). For EACH agent: open it, wait for the canvas to load, click the rocket icon in the right toolbar (the Sources panel), then run this with browser_evaluate:\n${cbOffProbe(locationId)}\nIt returns {"total": N, "match": [names]}. "match" lists the sources of THIS account in that agent (matched by location id, not by name). If "match" is empty, this agent is fine — go to the next one.`,
    `When "match" has a name: type that exact name in the panel's "Filter sources..." box, click the × at the end of that row, then click the red "Really?" that appears (the row disappears). Run the same browser_evaluate again: "match" must now be empty and "total" one lower. Only then click the green "Publish" button at the top right once and wait until it says "Published". Screenshot the panel ("after-1.png", "after-2.png", … one per agent changed).`,
    `If a probe returns "panel not open", open the rocket icon again and retry once. If "match" still lists the name after removing, or Publish fails, stop and end with "CLOSEBOT: STUCK — <what happened>". Never click × on a row whose name is not in "match".`,
    `End your report with exactly one line: "CLOSEBOT: REMOVED — <the agents you changed>", or "CLOSEBOT: NONE" if no agent had this account.`,
  ];
}

export type QueueResult = { taskId: string; reused: boolean } | { skipped: string };

export async function queueCloseBotOff(svc: Svc, args: { locationId: string; poolName: string; oldNames: string[]; by: string; minDaysSinceLast?: number }): Promise<QueueResult> {
  const conversationId = cbOffConvId(args.locationId);
  // Only an unclaimed pool account: once a setup takes it, its CloseBot source is the new client's.
  const { data: pool } = await svc.from("pool_accounts").select("status").eq("location_id", args.locationId).maybeSingle();
  if ((pool as { status?: string } | null)?.status !== "available") return { skipped: "not an unclaimed pool account" };
  const { data: open } = await svc.from("agent_proposals").select("id")
    .eq("conversation_id", conversationId).in("status", ["queued_browser", "running"]).limit(1).maybeSingle();
  if (open) return { taskId: (open as { id: string }).id, reused: true };
  const { data: prior } = await svc.from("agent_proposals").select("id, created_at")
    .eq("conversation_id", conversationId).order("created_at", { ascending: false });
  const rows = (prior ?? []) as Array<{ id: string; created_at: string }>;
  if (args.minDaysSinceLast && rows[0] && Date.now() - Date.parse(rows[0].created_at) < args.minDaysSinceLast * 86400_000) {
    return { skipped: `last tried ${usDate(rows[0].created_at)}` };
  }
  const { data: ins, error } = await svc.from("agent_proposals").insert({
    conversation_id: conversationId,
    message_id: `${CB_OFF_KEY}#${rows.length + 1}`,
    contact_id: null,
    contact_name: args.poolName,
    channel: null,
    client_message: `Clean-account pool: turn the CloseBot AI off for ${args.poolName} (${args.locationId}). A cleaned account keeps its old CloseBot source on the agents with the AI on; the next client on this account would get the old setup. Queued by ${args.by} on ${usDate(now())}.`,
    summary: `Pool: CloseBot AI off on ${args.poolName} (remove its source from every agent + publish)`.slice(0, 500),
    action_type: "account_change",
    proposed_reply: null,
    action_detail: `In CloseBot, remove the source of location ${args.locationId} from every agent it is attached to and publish each changed agent. Match by location id only. Change nothing else.`.slice(0, 1500),
    action_plan: cbOffPlan(args.locationId, args.poolName, args.oldNames).map((what) => ({ type: "manual", what })),
    location_id: args.locationId,
    status: "queued_browser",
    decided_by: `${args.by} (CloseBot off)`,
    decided_at: now(),
    executed_at: now(),
    result: "⏳ Waiting for the AI Agent (CloseBot off)",
  }).select("id").maybeSingle();
  if (error || !ins) throw new Error(`could not queue the CloseBot-off task: ${error?.message ?? "insert failed"}`);
  return { taskId: (ins as { id: string }).id, reused: false };
}
