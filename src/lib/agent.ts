import Anthropic from "@anthropic-ai/sdk";
import { createServiceClient } from "@/lib/supabase/server";
import { fileAlert } from "@/lib/alerts";
import {
  getReplyAccount,
  getRecentConversations,
  getThread,
  sendConversationMessage,
  type PmuAccount,
} from "@/lib/ghl-conversations";

// ── CEO Agent (phase 1) ──────────────────────────────────────────────────────
// Watches client conversations in the main sub-account, detects messages that
// ASK the agency to do something, and files a PROPOSAL for the owner to
// approve or deny on the AI tab. NOTHING executes without an explicit Approve.
// Phase 1 execution = sending the approved reply; account changes are queued
// for the (future) browser worker instead of failing silently.

const MODEL = "claude-sonnet-4-5";

export type Proposal = {
  id: string;
  created_at: string;
  conversation_id: string;
  message_id: string;
  contact_id: string | null;
  contact_name: string;
  channel: string | null;
  client_message: string;
  summary: string;
  action_type: "reply" | "account_change";
  proposed_reply: string | null;
  action_detail: string | null;
  status: "pending" | "denied" | "done" | "failed" | "queued_browser";
  decided_by: string | null;
  decided_at: string | null;
  executed_at: string | null;
  result: string | null;
};

type Classification = {
  actionable: boolean;
  summary?: string;
  action_type?: "reply" | "account_change";
  proposed_reply?: string;
  action_detail?: string;
  // Churn-risk read of the SAME conversation — independent of actionable.
  upset?: boolean;
  upset_reason?: string;
};

// One conversation's tail → does the client want something done? The model
// only CLASSIFIES and DRAFTS here — it has no tools and can't touch anything.
async function classify(
  client: Anthropic,
  contactName: string,
  tail: Array<{ direction: string; body: string }>,
): Promise<Classification | null> {
  const convo = tail.map((m) => `${m.direction === "inbound" ? contactName : "Agency"}: ${m.body}`).join("\n");
  const prompt = `You triage messages for a PMU (permanent-makeup) marketing agency. The people writing in are the agency's CLIENTS (artists whose ads/funnels/booking systems the agency runs).

Conversation (oldest to newest):
"""
${convo}
"""

Look at the LATEST client message(s). Decide if the client is asking the agency to DO something (change hours/availability, pause or restart ads, change pricing or offer on their funnel, fix something broken, update their services, refund something, etc.) — or just chatting / already answered.

Reply with ONLY a JSON object, no other text:
{
  "actionable": true/false,
  "summary": "<one sentence: what the client wants>",
  "action_type": "reply" | "account_change",
  "proposed_reply": "<a short, warm reply in the agency's casual texting style, confirming what will be done or answering the question>",
  "action_detail": "<for account_change: exactly what to change, where (which setting/page), so a teammate could do it>",
  "upset": true/false,
  "upset_reason": "<only when upset: one sentence on why this client is a churn risk>"
}

Rules:
- "reply" = a message back fully handles it (a question, confirmation, scheduling info).
- "account_change" = something in their account/funnel/ads must actually be changed. Still include proposed_reply (an acknowledgment).
- Refunds, payments, cancellations of the agency service: action_type "account_change", and START action_detail with "SENSITIVE:".
- If the last message is from the Agency (already handled) or nothing is being asked: {"actionable": false}.
- "upset" is SEPARATE from actionable: set it true when the client sounds like a churn risk — wants to leave or cancel the service, asks for a refund or compensation, says they're frustrated/disappointed/not seeing results, or keeps repeating the same complaint. Normal questions, small fix requests, or neutral chatting are NOT upset. Always include "upset" (false when calm).`;

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 500,
    messages: [{ role: "user", content: prompt }],
  });
  const text = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]) as Classification; } catch { return null; }
}

// Sweep recent unread conversations and file proposals for new actionable
// client messages. Dedupe = unique (conversation_id, message_id): a message
// is only ever proposed once, however many times the cron sees it.
export async function scanForProposals(): Promise<{ scanned: number; filed: number; errors: string[] }> {
  const errors: string[] = [];
  if (!process.env.ANTHROPIC_API_KEY) return { scanned: 0, filed: 0, errors: ["ANTHROPIC_API_KEY not set"] };
  const acct = await getReplyAccount();
  if (!acct) return { scanned: 0, filed: 0, errors: ["PMU Bookings On Demand token not found"] };

  const svc = createServiceClient();
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const convs = await getRecentConversations(acct, 30, { unreadOnly: true });
  let filed = 0;
  let scanned = 0;

  // Owner name -> business name, so alerts can say WHO the client is
  // ("Christy Ray (Ink & Ivory Beauty)") — user request 2026-08-30.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]+/g, " ").trim();
  const bizByOwner = new Map<string, string>();
  try {
    const { data: cm } = await svc.from("clients_master").select("data");
    for (const row of (cm ?? []) as Array<{ data: Record<string, unknown> }>) {
      const owner = norm(String(row.data?.["Owner Full Name"] ?? ""));
      const biz = String(row.data?.["Business Name"] ?? "").trim();
      if (owner && biz && !bizByOwner.has(owner)) bizByOwner.set(owner, biz);
    }
  } catch { /* alerts still file without the business name */ }
  const businessFor = (contactName: string): string | null => {
    const n = norm(contactName);
    if (!n) return null;
    if (bizByOwner.has(n)) return bizByOwner.get(n)!;
    // Loose match: every token of the shorter name inside the longer one.
    const toks = n.split(" ").filter((t) => t.length >= 2);
    for (const [owner, biz] of bizByOwner) {
      const ot = owner.split(" ").filter((t) => t.length >= 2);
      const [small, big] = toks.length <= ot.length ? [toks, ot] : [ot, toks];
      if (small.length >= 2 && small.every((t) => big.includes(t))) return biz;
    }
    return null;
  };

  for (const c of convs) {
    if (scanned >= 20) break; // stay well inside the cron's time budget
    try {
      const thread = await getThread(acct, c.id);
      if (!thread.length) continue;
      const last = thread[thread.length - 1];
      if (last.direction !== "inbound") continue; // already answered
      // Skip if this exact message was already proposed (or decided).
      const { data: existing } = await svc
        .from("agent_proposals")
        .select("id")
        .eq("conversation_id", c.id)
        .eq("message_id", last.id)
        .maybeSingle();
      if (existing) continue;

      scanned++;
      const tail = thread.slice(-10).map((m) => ({ direction: m.direction, body: m.body }));
      const cls = await classify(anthropic, c.contactName, tail);
      // Churn-risk clients hit the Alerts board whether or not there's a
      // concrete ask to act on — the CEO wants to know either way. The alert
      // carries the business name and the client's actual recent messages so
      // the CEO can judge for himself (user request 2026-08-30).
      if (cls?.upset) {
        const biz = businessFor(c.contactName);
        const recentInbound = thread.filter((m) => m.direction === "inbound").slice(-3);
        const msgs = recentInbound.map((m) => `• "${m.body.slice(0, 400)}"`).join("\n");
        await fileAlert(svc, {
          type: "upset_client",
          title: `${c.contactName}${biz ? ` (${biz})` : ""} sounds unhappy — churn risk`,
          detail: `${cls.upset_reason ?? ""}\n\nTheir last message${recentInbound.length > 1 ? "s" : ""}:\n${msgs}`.trim(),
          source_key: `msg:${c.id}:${last.id}`,
          meta: { conversation_id: c.id, contact_id: c.contactId, contact_name: c.contactName, business_name: biz, channel: c.channel },
        });
      }
      if (!cls?.actionable || !cls.summary) continue;

      const { error } = await svc.from("agent_proposals").insert({
        conversation_id: c.id,
        message_id: last.id,
        contact_id: c.contactId,
        contact_name: c.contactName,
        channel: c.channel,
        client_message: last.body.slice(0, 2000),
        summary: cls.summary.slice(0, 500),
        action_type: cls.action_type === "account_change" ? "account_change" : "reply",
        proposed_reply: cls.proposed_reply?.slice(0, 1500) ?? null,
        action_detail: cls.action_detail?.slice(0, 1500) ?? null,
      });
      if (error) {
        if (!/duplicate/i.test(error.message)) errors.push(`${c.contactName}: ${error.message}`);
      } else filed++;
    } catch (e) {
      errors.push(`${c.contactName}: ${e instanceof Error ? e.message.slice(0, 120) : "error"}`);
    }
  }
  return { scanned, filed, errors };
}

// Execute an APPROVED proposal. Phase 1: send the (possibly edited) reply;
// account changes additionally queue for the browser worker. Refund/payment
// actions ("SENSITIVE:") are never auto-executed beyond the reply.
export async function executeProposal(
  p: Proposal,
  replyText: string | null,
  decidedBy: string,
): Promise<{ status: Proposal["status"]; result: string }> {
  const svc = createServiceClient();
  let sendNote = "no reply sent";
  let ok = true;

  if (replyText && replyText.trim()) {
    if (!p.contact_id) { ok = false; sendNote = "no contact id on the conversation — send by hand"; }
    else {
      const acct: PmuAccount | null = await getReplyAccount();
      if (!acct) { ok = false; sendNote = "PMU account token unavailable"; }
      else {
        const r = await sendConversationMessage(acct, {
          contactId: p.contact_id,
          message: replyText.trim(),
          channel: p.channel ?? "SMS",
        });
        ok = r.ok;
        sendNote = r.ok ? `reply sent (${p.channel ?? "SMS"})` : `send failed: ${r.error}`;
      }
    }
  }

  const needsBrowser = p.action_type === "account_change";
  const status: Proposal["status"] = !ok ? "failed" : needsBrowser ? "queued_browser" : "done";
  const result = needsBrowser ? `${sendNote} · account change queued for the browser worker` : sendNote;

  await svc.from("agent_proposals").update({
    status,
    decided_by: decidedBy,
    decided_at: new Date().toISOString(),
    executed_at: new Date().toISOString(),
    result,
    ...(replyText && replyText.trim() ? { proposed_reply: replyText.trim() } : {}),
  }).eq("id", p.id);

  return { status, result };
}
