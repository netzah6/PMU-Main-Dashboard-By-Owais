import type { SupabaseClient } from "@supabase/supabase-js";
import { CLOSEBOT_SIGN_IN } from "@/lib/closebot-signin";
import type { CbClientState } from "@/lib/closebot-coverage";

/* ── "Connect to CloseBot" button on the client profile (owner, 11/23/2026) ──
   The CloseBot box on a client's profile says "Not connected" when the daily
   check finds no working agent for a V3 client. The owner wanted that box to
   be clickable: one click sends the job to the Mac Mini, which connects the
   client to CloseBot with the same setup every V3 client has (the recipe of
   the new-client setup step "Connect to CloseBot").

   Task: agent_proposals row, conversation_id = 'closebot:<location id>:connect'.
   The box shows the task's progress; the next daily check turns it green.
   The report's LAST line must be one of:
     "CLOSEBOT: CONNECTED"
     "CLOSEBOT: STUCK — <why>"            */

type Svc = SupabaseClient;
const now = () => new Date().toISOString();
const usDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });

export const CB_CONNECT_PREFIX = "closebot:";
export const CB_CONNECT_KEY = "connect";
export const cbConnectConvId = (locationId: string) => `${CB_CONNECT_PREFIX}${locationId}:${CB_CONNECT_KEY}`;
export function parseCbConnectConvId(conversationId: string | null | undefined): { locationId: string } | null {
  if (!conversationId?.startsWith(CB_CONNECT_PREFIX)) return null;
  const [, locationId, key] = conversationId.split(":");
  return locationId && key === CB_CONNECT_KEY ? { locationId } : null;
}

const SLAY = "slay (bot_OMQ35MOH48F6T4Z1)";

export function cbConnectPlan(a: { locationId: string; business: string; firstName: string; state: CbClientState; source: string | null }): string[] {
  const { locationId: L, business: biz, firstName: first } = a;
  const why: Record<string, string> = {
    no_source: "The daily check found NO CloseBot source for this account.",
    disconnected: `The daily check found the source${a.source ? ` "${a.source}"` : ""} but it is DISCONNECTED from GoHighLevel.`,
    no_flow: `The daily check found the source${a.source ? ` "${a.source}"` : ""} but no agent uses it.`,
    off: `The daily check found the source${a.source ? ` "${a.source}"` : ""} on an agent, but switched OFF.`,
  };
  return [
    `First open https://app.gohighlevel.com/v2/location/${L}/dashboard and read the sub-account name at the top left. It should be "${biz}". If it is a "Clean New Account" name or another client's name, change nothing anywhere and end with "CLOSEBOT: STUCK — account is named <name>".`,
    `This task works in CloseBot (https://app.closebot.com), for this one client only: ${biz}, GoHighLevel location ${L}. Never change another client's source or anything else in an agent. ${why[a.state] ?? ""} ${CLOSEBOT_SIGN_IN}`,
    `Open https://app.closebot.com/settings/sources and look for ${biz}'s source${a.source ? ` (it may be named "${a.source}")` : ""}. If the source shows as disconnected, use its Reconnect / Connect HighLevel button: on the GoHighLevel page click Login, then Next, pick "${biz}".`,
    `No source yet: Add New Source → HighLevel Sub-Account → "Connect HighLevel Sub-Account Now". On the GoHighLevel page click Login, then Next, search "${biz}" and click it. The source is created even if the dialog's "Add Source" is not pressed. If this account is not in the list, or GoHighLevel asks for a sign-in you can't finish, end with "CLOSEBOT: STUCK — <why>".`,
    `Open the source → Settings: Bot Auto Shutoff ON. Follow-Up Restrictions: Mon–Fri 08:00–20:00, Sat 09:00–20:00, Sun 10:00–20:00. Reply Restrictions: none. Press the bottom-right "Save changes" (a hidden "Save" does not persist).`,
    `Source → Variables: Override Name ON, enter "${first}", press "Save changes".`,
    `Open the agent ${SLAY}. If its editor ALREADY shows "Publish" before you change anything, someone has unpublished edits: change nothing and end with "CLOSEBOT: STUCK — slay has unpublished edits, the owner must publish first".`,
    `Right toolbar rocket icon = Sources panel. If ${biz}'s source is already listed, make sure it is switched ON with channel SMS and filters "tag is (v3)" and "tag is ai on". If not listed: + New → ${biz}'s source. Channel: SMS. Filters: "tag is (v3)", then "Add filter" → "tag is ai on" (the grey "tag is not ai off" is built in). Then press Publish once and wait for "Published". Do not change the agent's prompt or anything else.`,
    `Reload the Sources panel and confirm ${biz} is listed, ON, with SMS and both filters; reload the source and confirm Bot Auto Shutoff and the Override Name stuck. Screenshot both ("after-1.png", "after-2.png"). Do not send any message to anyone.`,
    `End your report with exactly one line: "CLOSEBOT: CONNECTED", or "CLOSEBOT: STUCK — <what happened>".`,
  ];
}

export type CbConnectTask = { id: string; status: string; result: string | null; at: string };

export async function latestCbConnect(svc: Svc, locationId: string): Promise<CbConnectTask | null> {
  const { data } = await svc.from("agent_proposals").select("id, status, result, created_at")
    .eq("conversation_id", cbConnectConvId(locationId)).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const r = data as { id: string; status: string; result: string | null; created_at: string } | null;
  return r ? { id: r.id, status: r.status, result: r.result, at: r.created_at } : null;
}

export async function queueCloseBotConnect(svc: Svc, a: { locationId: string; business: string; ownerName: string; state: CbClientState; source: string | null; by: string }): Promise<{ taskId: string; reused: boolean }> {
  const conversationId = cbConnectConvId(a.locationId);
  const { data: open } = await svc.from("agent_proposals").select("id")
    .eq("conversation_id", conversationId).in("status", ["queued_browser", "running"]).limit(1).maybeSingle();
  if (open) return { taskId: (open as { id: string }).id, reused: true };
  const { count } = await svc.from("agent_proposals").select("id", { count: "exact", head: true }).eq("conversation_id", conversationId);
  const firstName = a.ownerName.trim().split(/\s+/)[0] || a.business;
  const { data: ins, error } = await svc.from("agent_proposals").insert({
    conversation_id: conversationId,
    message_id: `${CB_CONNECT_KEY}#${(count ?? 0) + 1}`,
    contact_id: null,
    contact_name: a.business,
    channel: null,
    client_message: `Connect ${a.business} to CloseBot (slay agent, the standard V3 setup). Clicked on the client profile by ${a.by} on ${usDate(now())}.`,
    summary: `CloseBot: connect ${a.business} to the slay agent`.slice(0, 500),
    action_type: "account_change",
    proposed_reply: null,
    action_detail: `In CloseBot, connect location ${a.locationId} (${a.business}) to the slay agent with the standard V3 setup. Change nothing for any other client.`.slice(0, 1500),
    action_plan: cbConnectPlan({ locationId: a.locationId, business: a.business, firstName, state: a.state, source: a.source }).map((what) => ({ type: "manual", what })),
    location_id: a.locationId,
    status: "queued_browser",
    decided_by: `${a.by} (CloseBot connect)`,
    decided_at: now(),
    executed_at: now(),
    result: "⏳ Waiting for the AI Agent (CloseBot connect)",
  }).select("id").maybeSingle();
  if (error || !ins) throw new Error(`could not queue the CloseBot task: ${error?.message ?? "insert failed"}`);
  return { taskId: (ins as { id: string }).id, reused: false };
}
