import { guardReply } from "@/lib/call-guard";
import Anthropic from "@anthropic-ai/sdk";
import { createServiceClient } from "@/lib/supabase/server";
import { fileOrAppendAlert, ghlContactUrl, loadTeamLookup } from "@/lib/alerts";
import {
  getReplyAccount,
  getRecentConversations,
  getThread,
  getRoster,
  sendConversationMessage,
  formatThreadForPrompt,
  firstUnansweredIndex,
  type PmuAccount,
  type ThreadMessage,
} from "@/lib/ghl-conversations";
import { draftReplyFor } from "@/lib/reply-draft";
import {
  PLAN_SCHEMA_TEXT, sanitizePlan, planFromDetail, resolveClientLocation, executePlan, formatResults,
  withPaymentLinks, describeAmounts, type PlanStep,
} from "@/lib/agent-exec";
import { billingFor, billingLine, createLinksForProposal, NothingSentError, type Billing, type LinkStep } from "@/lib/agent-pay-links";
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
// The conversation is the dated last-2-days view (formatThreadForPrompt):
// the old 10-message, undated tail cut off what a client said yesterday.
// `force` = a person clicked "Let AI handle it" on this chat, so always
// return the best read of what's needed instead of "not actionable".
async function classify(
  client: Anthropic,
  contactName: string,
  convo: string,
  opts: { force?: boolean; billing?: Billing | null } = {},
): Promise<Classification | null> {
  const prompt = `You triage messages for a PMU (permanent-makeup) marketing agency. The people writing in are the agency's CLIENTS (artists whose ads/funnels/booking systems the agency runs).

Conversation (each line has its day and time; lines marked NEW are not answered yet; "Automated" lines are workflow texts):
"""
${convo}
"""

What this client owes the agency (Financing sheet): ${billingLine(opts.billing ?? null)}${opts.billing ? ` = ${opts.billing.cents} cents` : ""}

Read the client's NEW messages together with what was said earlier today and yesterday — clients often split one request across several texts. Decide if the client is asking the agency to DO something (change hours/availability, pause or restart ads, change pricing or offer on their funnel, fix something broken, update their services, refund something, etc.) — or just chatting / already answered.

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

Rules:
- "summary": at most 12 words, plain and direct, the ask itself — no "Client wants", no explanation (e.g. "Block Oct 8, 9, 15, 16, 22 on the calendar").
- "proposed_reply": at most 2 short sentences, no filler. Never invite them to a call or meeting and never write a link (payment links are added to the reply automatically). Mirror the client's layout: if their message opened with a greeting line, open with one; if it closed with a thank-you line and their first name, close with a warm line and the first name the client addressed (e.g. "Nicolas") on its own line; a one-line text gets a one-line reply.
- "action_detail": one short sentence per change, nothing else.
- "reply" = a message back fully handles it (a question, confirmation, scheduling info).
- "account_change" = something in their account/funnel/ads must actually be changed. Still include proposed_reply (an acknowledgment).
- Refunds, charging their card, cancellations of the agency service: action_type "account_change", and START action_detail with "SENSITIVE:".
- A client asking to PAY — for a payment link, or to split / break up what they owe into parts — is NOT sensitive: use action_type "reply" with one "payment_links" step in action_plan (the agency texts them Square one-time links; they pay when they choose). Never answer that with "I'll check".
- ${opts.force
    ? `A teammate asked you to handle this conversation: ALWAYS return "actionable": true with a "summary" of what (if anything) is needed now. If nothing must change, use action_type "reply" and summarize what the reply should cover.`
    : `If the last message is from the Agency (already handled) or nothing is being asked: {"actionable": false}.`}
- "upset" is SEPARATE from actionable: set it true when the client sounds like a churn risk — wants to leave or cancel the service, asks for a refund or compensation, says they're frustrated/disappointed/not seeing results, or keeps repeating the same complaint. Normal questions, small fix requests, or neutral chatting are NOT upset. Always include "upset" (false when calm).
- Judge "upset" ONLY from the client's NEW messages. Earlier complaints were already seen and handled by the team — use them as background, never as the reason. If the NEW messages are calm (a request, a question, chatting), "upset" is false even if they complained before.`;

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
      const thread = await getThread(acct, convId, { labelMedia: true });
      if (!thread.length) continue;
      for (const card of cards) {
        const baseId = card.message_id.split("#")[0]; // on-demand cards: "<message id>#<ms>"
        const idx = thread.findIndex((m) => m.id === baseId);
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
        }).eq("id", card.id).eq("status", "pending").or(unclaimed()); // not mid-Approve
        if (!error) closed++;
      }
    } catch { /* next conversation */ }
  }
  return closed;
}

// The client's unanswered texts (up to 5) — automated reminders in between
// don't count as an answer, and our own messages are never shown as theirs.
function unansweredClientTexts(thread: ThreadMessage[]): string[] {
  return thread.slice(firstUnansweredIndex(thread)).filter((m) => m.direction === "inbound").map((m) => m.body).slice(-5);
}

// GHL user id → teammate name, for labelling who sent each message.
const rosterCache = new Map<string, { at: number; names: Map<string, string> }>();
async function rosterNames(acct: PmuAccount): Promise<Map<string, string>> {
  const hit = rosterCache.get(acct.locationId);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.names;
  const names = new Map<string, string>();
  try { for (const u of await getRoster(acct)) names.set(u.id, u.name); } catch { /* labels fall back to "Teammate" */ }
  rosterCache.set(acct.locationId, { at: Date.now(), names });
  return names;
}

/* The card's reply comes from the same engine as the AI tab's drafts — the
   real voice (the clicking teammate's, else Nicolas's), the knowledge base,
   the team notes and the dated last-2-days conversation. The triage model's
   own one-liner was generic (and never learned his style); it is only the
   fallback if drafting fails. */
async function replyFor(
  acct: PmuAccount, conversationId: string, contactName: string, thread: ThreadMessage[],
  cls: Classification, voiceEmail: string | null, contactId: string | null,
  links?: LinkStep | null,
): Promise<string | null> {
  // The triage one-liner is only a fallback — and it goes through the same
  // call-invite guard as every other draft.
  const fallback = guardReply(cls.proposed_reply?.slice(0, 1500) ?? null, thread);
  const linkNote = links
    ? ` We are texting them ${links.amounts_cents.length === 1 ? "a Square payment link" : `${links.amounts_cents.length} Square payment links`} (${describeAmounts(links.amounts_cents)}) for "${links.label}" right under your message — say so in one short, warm sentence (e.g. "Of course! Here are your links:"). Do NOT write any link, URL or placeholder yourself.`
    : "";
  // The links themselves are added under this message on Approve (the card previews them).
  const withLinks = (text: string | null) => (links ? (text?.trim() ? text : "Of course! Here you go:") : text);
  try {
    const change = cls.action_type === "account_change";
    const { draft } = await draftReplyFor({
      acct, conversationId, contactName, contactId, thread, voiceEmail, source: "agent", waitForMemory: false,
      instructions: `What the client needs (from triage): ${cls.summary ?? "see their NEW messages"}.${change ? " We will make this change — confirm it simply, and don't promise a time." : ""}${linkNote}`,
    });
    return withLinks(draft ? draft.slice(0, 1500) : fallback);
  } catch {
    return withLinks(fallback);
  }
}

/* The typed plan for a card: everything for an account change; for a reply,
   only payment links — unless the AI also needs a teammate (e.g. a payment
   ask with no bill on file): then it's an account change so that step isn't
   lost. The links carry the bill they were checked against. */
function planFor(cls: Classification, billing: Billing | null): { actionType: "reply" | "account_change"; plan: PlanStep[] } {
  const all = sanitizePlan(cls.action_plan);
  let actionType: "reply" | "account_change" = cls.action_type === "account_change" ? "account_change" : "reply";
  if (actionType === "reply" && all.some((s) => s.type === "manual")) actionType = "account_change";
  const plan = (actionType === "account_change" ? all : all.filter((s) => s.type === "payment_links")).map((s) =>
    s.type === "payment_links" && billing
      ? { ...s, bill_cents: billing.cents, bill_label: `${billing.month} bill`, bill_owner: billing.ownerName, bill_status: billing.status }
      : s);
  return { actionType, plan };
}
const linkStepOf = (plan: PlanStep[] | null | undefined): LinkStep | null =>
  (plan ?? []).find((s): s is LinkStep => s.type === "payment_links") ?? null;

/* "Let AI handle it" on one conversation (owner request 2026-10-01): read
   it now, file a pending card with the plan and the drafted reply, and hand
   the card back so the person sees the details before approving. Nothing
   runs here — Approve (/api/agent/decide) is still the only way anything is
   sent or changed. Re-clicking while a card is pending returns that card. */
export async function proposeForConversation(opts: {
  conversationId: string;
  contactId: string | null;
  contactName: string;
  channel: string | null;
  requestedBy: string;
  /** "re-read chat" clicked: plan again even if no new message arrived. */
  fresh?: boolean;
}): Promise<{ proposal?: Proposal; error?: string }> {
  if (!process.env.ANTHROPIC_API_KEY) return { error: "ANTHROPIC_API_KEY not set" };
  const acct = await getReplyAccount();
  if (!acct) return { error: "PMU Bookings On Demand token not found" };
  const svc = createServiceClient();

  const thread = await getThread(acct, opts.conversationId, { labelMedia: true });
  if (!thread.length) return { error: "No readable messages in this chat (calls/voicemails only?)" };
  const last = thread[thread.length - 1];
  const openCard = async () => (await svc.from("agent_proposals").select("*")
    .eq("conversation_id", opts.conversationId).eq("status", "pending")
    .order("created_at", { ascending: false }).limit(1).maybeSingle()).data as Proposal | null;

  // A pending card still covering the newest message is the answer; one
  // written before newer texts arrived is retired so the plan isn't stale.
  const open = await openCard();
  if (open && (isLiveClaim(open) || (!opts.fresh && open.message_id.split("#")[0] === last.id))) return { proposal: open }; // current, or mid-Approve
  const retire = async (why: string) => {
    if (!open) return;
    await svc.from("agent_proposals").update({
      status: "handled", decided_by: opts.requestedBy || "auto", decided_at: new Date().toISOString(), result: why,
    }).eq("id", open.id).eq("status", "pending").or(unclaimed()); // not mid-Approve
  };
  // New messages make the old plan wrong — retire it now. A re-read on
  // request keeps it until the new card exists (a failed re-plan leaves it).
  if (open && !opts.fresh) await retire("replaced by a newer read of the chat (new messages arrived)");
  const nameByUserId = await rosterNames(acct);
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const billing = await billingFor(svc, opts.contactName, opts.contactId).catch(() => null);
  const cls = await classify(anthropic, opts.contactName,
    formatThreadForPrompt(thread, { contactName: opts.contactName, nameByUserId }), { force: true, billing });
  if (!cls || !cls.summary) return { error: "The AI couldn't read this chat — try again" };

  const { actionType, plan } = planFor(cls, billing);
  let locationId: string | null = null;
  if (actionType === "account_change") {
    try { locationId = (await resolveClientLocation(svc, opts.contactId, opts.contactName))?.locationId ?? null; } catch { /* resolved again at approve */ }
  }
  const unanswered = unansweredClientTexts(thread);
  const lastInbound = [...thread].reverse().find((m) => m.direction === "inbound")?.body;
  const clientMessage = (unanswered.length ? unanswered : lastInbound ? [lastInbound] : []).join("\n").slice(0, 2000);
  const proposedReply = await replyFor(acct, opts.conversationId, opts.contactName, thread, cls, opts.requestedBy, opts.contactId, linkStepOf(plan));

  // The cron may have filed a card for this chat while we were drafting —
  // hand that one back rather than a second card for the same message.
  const raced = await openCard();
  if (raced && raced.id !== open?.id) return { proposal: raced };
  // One card per message: if this message already had a (decided) card,
  // key the new one "<id>#<ms>" so the unique (conversation, message) holds.
  const { data: prior } = await svc.from("agent_proposals").select("id")
    .eq("conversation_id", opts.conversationId).eq("message_id", last.id).maybeSingle();
  const { data: inserted, error } = await svc.from("agent_proposals").insert({
    conversation_id: opts.conversationId,
    message_id: prior ? `${last.id}#${Date.now()}` : last.id,
    contact_id: opts.contactId,
    contact_name: opts.contactName,
    channel: opts.channel,
    client_message: clientMessage,
    summary: cls.summary.slice(0, 500),
    action_type: actionType,
    proposed_reply: proposedReply,
    action_detail: cls.action_detail?.slice(0, 1500) ?? null,
    action_plan: plan.length ? plan : null,
    location_id: locationId,
  }).select("*").maybeSingle();
  if (error || !inserted) return { error: error?.message ?? "could not save the card" };
  if (opts.fresh) await retire("replaced — the chat was re-read on request");
  return { proposal: inserted as Proposal };
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
      const thread = await getThread(acct, c.id, { labelMedia: true });
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
      const nameByUserId = await rosterNames(acct);
      const billing = await billingFor(svc, c.contactName, c.contactId).catch(() => null);
      const cls = await classify(anthropic, c.contactName, formatThreadForPrompt(thread, { contactName: c.contactName, nameByUserId }), { billing });
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

      const { actionType, plan } = planFor(cls, billing);
      // The client's OWN sub-account, where an approved change will land.
      let locationId: string | null = null;
      if (actionType === "account_change") {
        try { locationId = (await resolveClientLocation(svc, c.contactId, c.contactName))?.locationId ?? null; } catch { /* resolved again at approve */ }
      }
      // The client's latest texts, not just the last one — "Can we add a
      // column" / "Before declining" / "Please and thank you" arrive as three
      // messages and the card must show all three.
      const recentInbound = unansweredClientTexts(thread);
      const proposedReply = await replyFor(acct, c.id, c.contactName, thread, cls, null, c.contactId, linkStepOf(plan));
      const { data: inserted, error } = await svc.from("agent_proposals").insert({
        conversation_id: c.id,
        message_id: last.id,
        contact_id: c.contactId,
        contact_name: c.contactName,
        channel: c.channel,
        client_message: recentInbound.join("\n").slice(0, 2000),
        summary: cls.summary.slice(0, 500),
        action_type: actionType,
        proposed_reply: proposedReply,
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

// An Approve claims its card (decided_at set, status still "pending") for
// the length of the run. A claim older than this is a run that died — the
// decide route may re-claim it and the cron/re-check may treat it as open.
export { NothingSentError };
export const CLAIM_TTL_MS = 2 * 60_000;
export const claimCutoff = () => new Date(Date.now() - CLAIM_TTL_MS).toISOString();
const unclaimed = () => `decided_at.is.null,decided_at.lt."${claimCutoff()}"`;
export const isLiveClaim = (p: { decided_at: string | null }) =>
  !!p.decided_at && Date.now() - Date.parse(p.decided_at) < CLAIM_TTL_MS;

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

  /* Phase 0: payment links. Made BEFORE anything is sent — if Square says
     no, nothing goes out and the card stays approvable (NothingSentError).
     The link lines in the reply are rebuilt from the final amounts. */
  const linkStep = linkStepOf(p.action_plan);
  let linkNote = "";
  if (linkStep) {
    // The links go out under a message — an empty box would send bare links.
    if (!replyText?.replace(/^.*\{\{pay_link_\d+\}\}.*$/gm, "").trim()) throw new NothingSentError("Type a short message to go with the payment links (or Deny) — nothing was sent");
    const links = await createLinksForProposal(svc, p, linkStep, decidedBy);
    linkStep.links = links;
    replyText = withPaymentLinks(replyText ?? "", linkStep, links.map((l) => l.url));
    linkNote = `\n💳 ${links.length === 1 ? "Square payment link" : `${links.length} Square payment links`} created (${describeAmounts(links.map((l) => l.amount_cents))}):\n${links.map((l) => `  ${l.url}`).join("\n")}`;
    // Saved now: if the run dies after the text goes out, the links are on the card.
    await svc.from("agent_proposals").update({ action_plan: p.action_plan }).eq("id", p.id);
  }

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
        // Mark that the text is out before the slow part: if this run is
        // killed (timeout) the card must never be approved — and texted — again.
        if (r.ok) await svc.from("agent_proposals").update({ executed_at: new Date().toISOString() }).eq("id", p.id);
      }
    }
  }

  // Phase 2: run the account change in the client's sub-account and keep
  // the before → after per step as proof. "SENSITIVE:" (refunds, payments,
  // cancellations) is never executed — a person handles money.
  let status: Proposal["status"] = ok ? "done" : "failed";
  let result = `${sendNote}${linkNote}`;
  let plan: PlanStep[] | null = linkStep ? (p.action_plan ?? null) : null;
  // The reply may already be out: an error past this point must finish the
  // card as "failed", never throw (a throw would leave it approvable again).
  try {
    if (p.action_type === "account_change") {
      const sensitive = (p.action_detail ?? "").startsWith("SENSITIVE:");
      if (sensitive) {
        status = ok ? "queued_browser" : "failed";
        result = `${sendNote}${linkNote}\n👤 Sensitive (money) — a teammate must handle this by hand`;
      } else {
        // The account change itself (links were made above). An older card
        // without a plan gets one from its notes — never new payment links there.
        const own = (p.action_plan ?? []).filter((s) => s.type !== "payment_links");
        const steps = own.length
          ? own
          : (await planFromDetail({ summary: p.summary, actionDetail: p.action_detail, clientMessage: p.client_message }))
              .map((s): PlanStep => (s.type === "payment_links" ? { type: "manual", what: `Send payment links: ${describeAmounts(s.amounts_cents)} (${s.label})` } : s));
        plan = [...(linkStep ? [linkStep] : []), ...steps];
        const loc = p.location_id
          ? { locationId: p.location_id }
          : await resolveClientLocation(svc, p.contact_id, p.contact_name);
        if (!loc) {
          status = "failed";
          result = `${sendNote}${linkNote}\n✗ Could not find ${p.contact_name}'s sub-account (no Clients Master match) — do it by hand`;
        } else {
          const run = await executePlan(steps, loc.locationId);
          const lines = formatResults(run.steps);
          status = !ok || !run.allOk ? "failed" : run.anyManual ? "queued_browser" : "done";
          result = `${sendNote}${linkNote}\n${lines}`;
          if (!p.location_id) await svc.from("agent_proposals").update({ location_id: loc.locationId }).eq("id", p.id);
        }
      }
    }
  } catch (e) {
    status = "failed";
    result = `${sendNote}${linkNote}\n✗ ${e instanceof Error ? e.message : "error"} — check the account and finish by hand`;
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
