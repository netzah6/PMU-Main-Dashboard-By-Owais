import Anthropic from "@anthropic-ai/sdk";
import { createServiceClient } from "@/lib/supabase/server";
import { fileOrAppendAlert, ghlContactUrl, loadTeamLookup } from "@/lib/alerts";
import {
  getReplyAccount,
  getRecentConversations,
  getThread,
  getRoster,
  sendConversationMessage,
  type PmuAccount,
} from "@/lib/ghl-conversations";
import {
  PLAN_SCHEMA_TEXT, sanitizePlan, planFromDetail, resolveClientLocation, executePlan, formatResults,
  type PlanStep,
} from "@/lib/agent-exec";
import { notifyOwner, type NotifyItem } from "@/lib/agent-notify";

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
  // `handled` = the team answered in the chat before anyone clicked; the
  // scan closes the card on its own (owner request 2026-09-28).
  status: "pending" | "denied" | "done" | "failed" | "queued_browser" | "handled";
  decided_by: string | null;
  decided_at: string | null;
  executed_at: string | null;
  result: string | null;
  // Phase 2 (2026-09-28): the typed steps Approve runs, the client's own
  // sub-account they run in, and when the owner was texted about the card.
  action_plan?: PlanStep[] | null;
  location_id?: string | null;
  notified_at?: string | null;
};

type Classification = {
  actionable: boolean;
  summary?: string;
  action_type?: "reply" | "account_change";
  proposed_reply?: string;
  action_detail?: string;
  action_plan?: unknown;
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
  ${PLAN_SCHEMA_TEXT}
  "upset": true/false,
  "upset_reason": "<only when upset: one sentence on why this client is a churn risk>"
}

Today is ${new Date().toISOString().slice(0, 10)}.

Rules:
- "summary": at most 12 words, plain and direct, the ask itself — no "Client wants", no explanation (e.g. "Block Oct 8, 9, 15, 16, 22 on the calendar").
- "proposed_reply": at most 2 short sentences, no filler.
- "action_detail": one short sentence per change, nothing else.
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
// ── Cards the team already handled in the chat close themselves ─────────────
// Owner (2026-09-28): "if I already take care of the request and reply in the
// chat, just remove the pop-up". A pending card whose conversation has an
// OUTBOUND message after the client's message is finished — mark it
// `handled`, note who replied and when, and leave it in History.
async function closeHandledProposals(acct: PmuAccount, svc: ReturnType<typeof createServiceClient>): Promise<number> {
  const { data } = await svc
    .from("agent_proposals")
    .select("id, conversation_id, message_id")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(60);
  const pending = (data ?? []) as Array<{ id: string; conversation_id: string; message_id: string }>;
  if (!pending.length) return 0;
  const byConv = new Map<string, typeof pending>();
  for (const p of pending) (byConv.get(p.conversation_id) ?? byConv.set(p.conversation_id, []).get(p.conversation_id)!).push(p);
  let roster: Map<string, string> | null = null;
  let closed = 0;
  let looked = 0;
  for (const [convId, cards] of byConv) {
    // GHL thread reads can stall for minutes; 15 chats per run keeps the
    // cron inside its budget and the rest close on the next pass.
    if (looked++ >= 15) break;
    try {
      const thread = await getThread(acct, convId);
      if (!thread.length) continue;
      for (const card of cards) {
        const idx = thread.findIndex((m) => m.id === card.message_id);
        // The card's message may have scrolled out of the last 100; then only
        // the newest message counts.
        const after = idx >= 0 ? thread.slice(idx + 1) : thread.slice(-1);
        const reply = after.find((m) => m.direction === "outbound");
        if (!reply) continue;
        if (!roster) {
          roster = new Map();
          try { for (const u of await getRoster(acct)) roster.set(u.id, u.name); } catch { /* names optional */ }
        }
        const who = (reply.userId && roster.get(reply.userId)) || "the team";
        const when = reply.dateAdded
          ? new Date(reply.dateAdded).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
          : "";
        const { error } = await svc.from("agent_proposals").update({
          status: "handled",
          decided_by: "auto",
          decided_at: new Date().toISOString(),
          result: `handled in the chat by ${who}${when ? ` (${when})` : ""} — closed automatically`,
        }).eq("id", card.id).eq("status", "pending");
        if (!error) closed++;
      }
    } catch { /* next conversation */ }
  }
  return closed;
}

export async function scanForProposals(): Promise<{ scanned: number; filed: number; errors: string[] }> {
  const errors: string[] = [];
  if (!process.env.ANTHROPIC_API_KEY) return { scanned: 0, filed: 0, errors: ["ANTHROPIC_API_KEY not set"] };
  const acct = await getReplyAccount();
  if (!acct) return { scanned: 0, filed: 0, errors: ["PMU Bookings On Demand token not found"] };

  const svc = createServiceClient();
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  // First, retire cards the team already answered in the chat.
  let closed = 0;
  try { closed = await closeHandledProposals(acct, svc); } catch (e) { errors.push(`auto-close: ${e instanceof Error ? e.message.slice(0, 120) : "error"}`); }
  const convs = await getRecentConversations(acct, 30, { unreadOnly: true });
  let filed = 0;
  let scanned = 0;
  // Why each unread chat did NOT become a card — Tammy's request went
  // missing on 2026-09-28 and nothing said why. Shown on the Agent panel.
  const skipped: Array<{ who: string; why: string }> = [];
  const filedItems: NotifyItem[] = [];

  // Owner name -> business name, so alerts can say WHO the client is
  // ("Christy Ray (Ink & Ivory Beauty)") — user request 2026-08-30.
  const teamFor = await loadTeamLookup(svc); // "Assigned · Media buyer" chip on alerts
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]+/g, " ").trim();
  const bizByOwner = new Map<string, string>();
  const statusByOwner = new Map<string, string>();
  const statusByBiz = new Map<string, string>();
  const statusByContactId = new Map<string, string>();
  try {
    const { data: cm } = await svc.from("clients_master").select("data");
    for (const row of (cm ?? []) as Array<{ data: Record<string, unknown> }>) {
      const owner = norm(String(row.data?.["Owner Full Name"] ?? ""));
      const biz = String(row.data?.["Business Name"] ?? "").trim();
      if (owner && biz && !bizByOwner.has(owner)) bizByOwner.set(owner, biz);
      const status = String(row.data?.["col_1"] ?? "").trim().toLowerCase();
      if (owner) statusByOwner.set(owner, status);
      if (biz) statusByBiz.set(biz.toLowerCase(), status);
      const cid = String(row.data?.["Contact ID"] ?? "").trim();
      if (/^[A-Za-z0-9_-]{15,}$/.test(cid)) statusByContactId.set(cid, status);
    }
  } catch { /* alerts still file without the business name */ }
  // Only LIVE clients belong on the Alerts board (owner request 2026-09-12 —
  // an offboarded client's complaint is not something to act on). The contact
  // id on the Clients Master row is checked first because names drift; the
  // name and business matches are the fallback. Unknown = not a client = skip.
  const isLiveClient = (contactId: string | null, contactName: string, biz: string | null): boolean => {
    if (contactId && statusByContactId.has(contactId)) return statusByContactId.get(contactId) === "live";
    const n = norm(contactName);
    if (n && statusByOwner.has(n)) return statusByOwner.get(n) === "live";
    if (biz && statusByBiz.has(biz.toLowerCase())) return statusByBiz.get(biz.toLowerCase()) === "live";
    return false;
  };
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
      if (!thread.length) { skipped.push({ who: c.contactName, why: "no readable messages (call/voicemail only?)" }); continue; }
      const last = thread[thread.length - 1];
      if (last.direction !== "inbound") { skipped.push({ who: c.contactName, why: "last message is ours — already answered" }); continue; }
      // Skip if this exact message was already proposed (or decided).
      const { data: existing } = await svc
        .from("agent_proposals")
        .select("id")
        .eq("conversation_id", c.id)
        .eq("message_id", last.id)
        .maybeSingle();
      if (existing) continue; // already a card — not worth listing every 10 min

      scanned++;
      const tail = thread.slice(-10).map((m) => ({ direction: m.direction, body: m.body }));
      const cls = await classify(anthropic, c.contactName, tail);
      if (!cls) skipped.push({ who: c.contactName, why: "classifier returned nothing" });
      else if (!cls.actionable || !cls.summary) skipped.push({ who: c.contactName, why: `not a request (AI read: ${cls.summary ?? "chatting / already handled"})` });
      // Churn-risk clients hit the Alerts board whether or not there's a
      // concrete ask to act on — the CEO wants to know either way. The alert
      // carries the business name and the client's actual recent messages so
      // the CEO can judge for himself (user request 2026-08-30).
      // The alert is gated on Live status; the proposal below is not — a
      // non-live client's concrete request still reaches the AI inbox.
      if (cls?.upset && isLiveClient(c.contactId, c.contactName, businessFor(c.contactName))) {
        const biz = businessFor(c.contactName);
        const recentInbound = thread.filter((m) => m.direction === "inbound").slice(-3);
        const msgs = recentInbound.map((m) => `• "${m.body.slice(0, 400)}"`).join("\n");
        // ONE box per client (keyed by contact, not message): a fresh complaint
        // while the box is open lands inside it as a dated note instead of a
        // second alert (user request 2026-09-01).
        const day = new Date().toISOString().slice(0, 10);
        await fileOrAppendAlert(svc, {
          type: "upset_client",
          title: `${c.contactName}${biz ? ` (${biz})` : ""} sounds unhappy — churn risk`,
          detail: `${cls.upset_reason ?? ""}\n\nTheir last message${recentInbound.length > 1 ? "s" : ""}:\n${msgs}`.trim(),
          source_key: `upset:${c.contactId || c.id}`,
          meta: {
            conversation_id: c.id, contact_id: c.contactId, contact_name: c.contactName,
            business_name: biz, channel: c.channel,
            link: c.contactId ? ghlContactUrl(acct.locationId, c.contactId) : null,
            ...(() => {
              const t = teamFor(c.contactName) ?? teamFor(biz);
              return t ? { csm: t.assigned, media_buyer: t.mediaBuyer } : {};
            })(),
          },
          // After the CEO resolves a client's box, a complaint 2+ days later
          // opens a fresh one; a same-day rescan of old messages stays quiet.
          resurfaceAfterDays: 2,
        }, `— New (${day}): ${cls.upset_reason ?? "another complaint"}\n${msgs}`);
      }
      if (!cls?.actionable || !cls.summary) continue;

      const actionType = cls.action_type === "account_change" ? "account_change" : "reply";
      const plan = actionType === "account_change" ? sanitizePlan(cls.action_plan) : [];
      // The client's OWN sub-account, where an approved change will land.
      let locationId: string | null = null;
      if (actionType === "account_change") {
        try { locationId = (await resolveClientLocation(svc, c.contactId, c.contactName))?.locationId ?? null; } catch { /* resolved again at approve */ }
      }
      // The client's latest texts, not just the last one — "Can we add a
      // column" / "Before declining" / "Please and thank you" arrive as three
      // messages and the card must show all three.
      const recentInbound: string[] = [];
      for (let i = thread.length - 1; i >= 0 && thread[i].direction === "inbound" && recentInbound.length < 5; i--) recentInbound.unshift(thread[i].body);
      const { data: inserted, error } = await svc.from("agent_proposals").insert({
        conversation_id: c.id,
        message_id: last.id,
        contact_id: c.contactId,
        contact_name: c.contactName,
        channel: c.channel,
        client_message: recentInbound.join("\n").slice(0, 2000),
        summary: cls.summary.slice(0, 500),
        action_type: actionType,
        proposed_reply: cls.proposed_reply?.slice(0, 1500) ?? null,
        action_detail: cls.action_detail?.slice(0, 1500) ?? null,
        action_plan: plan.length ? plan : null,
        location_id: locationId,
      }).select("id").maybeSingle();
      if (error) {
        if (!/duplicate/i.test(error.message)) errors.push(`${c.contactName}: ${error.message}`);
      } else {
        filed++;
        const id = (inserted as { id?: string } | null)?.id;
        if (id) filedItems.push({ id, contact_name: c.contactName, business: businessFor(c.contactName), summary: cls.summary, action_type: actionType });
      }
    } catch (e) {
      errors.push(`${c.contactName}: ${e instanceof Error ? e.message.slice(0, 120) : "error"}`);
    }
  }

  // Tell the owner — one text per scan, however many cards it filed.
  let notify = { sent: false, note: "nothing filed" };
  if (filedItems.length) {
    try { notify = await notifyOwner(svc, filedItems); } catch (e) { notify = { sent: false, note: e instanceof Error ? e.message : "notify error" }; }
  }
  // Last-scan log for the Agent panel (no new table — one settings row).
  try {
    await svc.from("app_settings").upsert({
      key: "agent_scan_last",
      value: { at: new Date().toISOString(), unread: convs.length, scanned, filed, closed, skipped: skipped.slice(0, 30), errors: errors.slice(0, 10), notify },
      updated_by: "cron", updated_at: new Date().toISOString(),
    });
  } catch { /* the scan itself succeeded */ }
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

  // Phase 2: run the account change in the client's sub-account and keep
  // the before → after per step as proof. "SENSITIVE:" (refunds, payments,
  // cancellations) is never executed — a person handles money.
  let status: Proposal["status"] = ok ? "done" : "failed";
  let result = sendNote;
  let plan: PlanStep[] | null = null;
  if (p.action_type === "account_change") {
    const sensitive = (p.action_detail ?? "").startsWith("SENSITIVE:");
    if (sensitive) {
      status = ok ? "queued_browser" : "failed";
      result = `${sendNote}\n👤 Sensitive (money) — a teammate must handle this by hand`;
    } else {
      plan = p.action_plan && p.action_plan.length
        ? p.action_plan
        : await planFromDetail({ summary: p.summary, actionDetail: p.action_detail, clientMessage: p.client_message });
      const loc = p.location_id
        ? { locationId: p.location_id }
        : await resolveClientLocation(svc, p.contact_id, p.contact_name);
      if (!loc) {
        status = "failed";
        result = `${sendNote}\n✗ Could not find ${p.contact_name}'s sub-account (no Clients Master match) — do it by hand`;
      } else {
        const run = await executePlan(plan, loc.locationId);
        const lines = formatResults(run.steps);
        status = !ok || !run.allOk ? "failed" : run.anyManual ? "queued_browser" : "done";
        result = `${sendNote}\n${lines}`;
        if (!p.location_id) await svc.from("agent_proposals").update({ location_id: loc.locationId }).eq("id", p.id);
      }
    }
  }

  await svc.from("agent_proposals").update({
    status,
    decided_by: decidedBy,
    decided_at: new Date().toISOString(),
    executed_at: new Date().toISOString(),
    result,
    ...(plan ? { action_plan: plan } : {}),
    ...(replyText && replyText.trim() ? { proposed_reply: replyText.trim() } : {}),
  }).eq("id", p.id);

  return { status, result };
}
