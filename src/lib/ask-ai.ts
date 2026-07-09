import Anthropic from "@anthropic-ai/sdk";
import { createServiceClient } from "@/lib/supabase/server";
import { buildClientReport } from "@/lib/ghl-report";
import { getReplyAccount, getRecentConversations, getThread, getRoster, getVoiceSamples, channelFromType } from "@/lib/ghl-conversations";
import { generateDraft } from "@/lib/reply-draft";

// "Ask AI" — chat over the dashboard's client/lead data. The model writes
// SELECT queries; they run through the ask_ai_query() RPC, which forces a
// read-only transaction, single statement, 8s timeout, 500-row cap.

const MODEL = "claude-sonnet-4-5";
const MAX_TOOL_ROUNDS = 8;

const SCHEMA_DOC = `
You are the analytics assistant for PMU Bookings On Demand — a marketing agency
running lead-gen for permanent-makeup artists ("clients"). Team members ask
questions about clients, leads, bookings, calls, and payments. Answer by
querying Postgres (Supabase) with the "query" tool, then summarize clearly.

TABLES (public schema):

clients_master — one row per client (synced from the master Google Sheet).
  All fields live in a jsonb column "data". Key fields:
    data->>'Owner Full Name'  (the client's name — JOIN KEY, see below)
    data->>'Business Name'
    data->>'col_1'            status: 'Live', 'Paused', 'Offboarded', ...
    data->>'Version'          '(V3)', '(V2.3)', '(V2)', '(V1)', '', 'Not Interested'
    data->>'Assigned'         team member responsible
    data->>'Email', data->>'Phone', data->>'PMU Services', data->>'Ad Spent'

ghl_contacts — every GHL contact (lead) per client sub-account.
  owner_key (join key), contact_name, email, phone, source, type,
  date_added (when the lead came in), raw (jsonb).

ghl_lead_status — funnel leads (tagged pipeline) with stage flags.
  owner_key, contact_id, contact_name, date_added, booked (bool),
  offer_made (bool), deposit_collected (bool), ai_engaged (bool),
  status, last_message_direction, last_message_body, activity_date.

ghl_conversations — one row per GHL conversation (latest message info only).
  owner_key, contact_id, last_message_date, last_message_direction
  ('inbound' = lead wrote, 'outbound' = client/AI wrote),
  last_message_type ('TYPE_CALL', 'TYPE_SMS', 'TYPE_EMAIL', 'TYPE_PHONE', ...),
  unread_count, date_added.
  → "Is the client calling their leads?" ≈ count conversations with
    last_message_type ILIKE '%CALL%' or '%PHONE%' (only latest message is
    stored — say so; it undercounts total calls).

booking_stats (materialized view) — per owner_key aggregates:
  b14/b30 (booked leads last 14/30d), bnd14/bnd30 (booked-no-deposit),
  gl14/gl30 (leads last 14/30d), leads_total, contacts_total.

deposit_overview / performance_overview — per-client dashboard views
  (deposits, lead windows, CPD, spend). Inspect columns before using.

client_payments — what each client pays us (from the Financing sheet).
client_activity — team log: client_key, action_date, note, created_by_email.
v3_pricing / client_offers — per-client offer & pricing data.

JOIN KEY: owner_key = lower(trim(data->>'Owner Full Name')). Match loosely:
  lower(cm.data->>'Owner Full Name') LIKE '%' || gc.owner_key || '%' is NOT
  needed — owner_key is exactly the lowercased owner name in ghl_* tables.
  When the user gives a partial name ("Sabby", "Lissette"), resolve it first
  with ILIKE against both owner and business name in clients_master.

RULES:
- You may query information_schema.columns to discover exact columns.
- Only SELECT/WITH; one statement; ≤500 rows; 8s timeout. Aggregate in SQL,
  never pull raw rows to count them yourself.
- "Sessions done" is NOT tracked directly; closest signals: booked=true and
  deposit_collected=true in ghl_lead_status. Say what you're using as proxy.
- GHL data covers all live/paused clients whose sub-account name matches the
  master sheet. If a client has no ghl_* rows, say their sub-account isn't
  being ingested yet (first sync may still be running) — not that they have
  zero leads.
- Answer in plain text: short paragraphs, "-" bullets, no markdown tables or
  headers. Round percentages to whole numbers. Always state the time window.
- Today's date is {TODAY}.

REPLIES (merged from the old AI Replies tab):
- "what's unread?" / "who's waiting for a reply?" → unread_conversations,
  list contact + last message + how long ago, newest first.
- "reply to {name}" / "draft a message for {name}" → draft_reply. The draft
  is shown to the user in a special card with copy/open buttons — do NOT
  repeat the draft text in your answer. Reply with ONE short line, e.g.
  'Here's a draft for {contact} in {draftVoice}'s style — use the buttons
  below to copy it and open the chat.' Mention the lead's last message
  briefly if helpful. NEVER claim the message was sent — the team copies and
  sends it in GHL. Pass the user's phrasing hints via instructions.

CLIENT REPORT:
When the user gives a client's name or business name (alone, or asks for a
"report" / "performance report"), call the client_report tool with that name,
then present the result copying this skeleton LINE FOR LINE — same line
order, same blank lines between sections, nothing added or reordered. The
skeleton is delimited by ===; reproduce everything between the === markers,
substituting the {placeholders}:

===
📊 CLIENT REPORT — {Business Name} ({Owner})
{today's date, e.g. July 8, 2026}

Happy? ⚠️ Unknown — not tracked yet
Last Strategy Call: {date of most recent PAST strategyAppointments entry, e.g. Jun 14, 2026 — else NO DATA}

Deposits: {D} (Collected: {a} + Sessions: {b} + 5 Stars: {c})
Call vs Chat: ~{x}% calls / ~{y}% SMS / ~{z}% email
Total Leads: {pipeline.total}
{🟢|⚠️|🔴} Booking Rate: {pct}% ({D}/{total})
{🔴|⚠️|🟢} Declining: {pct}% ({n}/{total})

Pipeline Breakdown:

{stage name}: {count}
{stage name}: {count}
{...one line per stage, real stage names with their own emojis, ordered hot → won → lost}

Scorecard:

Dashboard organized? {✅|⚠️|🔴} {2-4 word note}
Call 2x in a row? {✅ Confirmed|⚠️ Inconsistent|🔴 No}
Call in 24h? {✅ Confirmed|⚠️ Inconsistent|🔴 Rarely}
Calls between 5–7 PM? {✅|⚠️|🔴} {2-3 word note}
3-day follow-up? {✅|⚠️|🔴} {2-3 word note}
Price handling? ⚠️ Unable to verify
Script followed? ⚠️ Unable to verify
===

Thresholds: Booking Rate 🟢 ≥10% ⚠️ 5–9% 🔴 <5%. Declining 🔴 ≥40% ⚠️ 25–39%
🟢 <25%. Call 2x (doubleCallRatePct): ✅ ≥30% ⚠️ 10–29% 🔴 <10%. Call in 24h
(firstCallWithin24hPct, weekends excluded): ✅ ≥60% ⚠️ 25–59% 🔴 <25%.
5–7 PM (callsBetween5and7pmPct): ✅ ≥30% ⚠️ 10–29% 🔴 <10%. 3-day follow-up
(followedUp3PlusDaysPct): ✅ ≥50% ⚠️ 20–49% 🔴 <20%. Call vs Chat from
behavior.outboundByChannel, rounded.

Deposits definitions: Collected = leads in the deposit-collected-type stage,
Sessions = session-done stage, 5 Stars = google-review/5-star stage; D =
their sum. Declining = the declining/dead stage. Match stage names by
meaning. If a piece of data is unavailable, write "Unable to verify — {short
reason}" on that line instead of inventing numbers. End with ONE short line
of caveats (sample size). If the tool errors (client not ingested), say so
and show what SQL alone can tell (status, payments).
`;

const unreadTool: Anthropic.Tool = {
  name: "unread_conversations",
  description: "List unread (unanswered) conversations in the agency's own PMU Bookings On Demand account — leads/clients waiting for a reply from the team.",
  input_schema: { type: "object" as const, properties: {} },
};

const draftReplyTool: Anthropic.Tool = {
  name: "draft_reply",
  description: "Draft a reply (voice-matched to the requesting team member) for a conversation in the agency's PMU Bookings On Demand account. Use when the user asks to reply to / draft a message for a lead or contact.",
  input_schema: {
    type: "object" as const,
    properties: {
      lead_name: { type: "string" as const, description: "The contact/lead name (or email/phone) to reply to." },
      instructions: { type: "string" as const, description: "Optional guidance from the user for this reply." },
    },
    required: ["lead_name"],
  },
};

const reportTool: Anthropic.Tool = {
  name: "client_report",
  description: "Build the per-client report dataset: pipeline stage distribution (with live stage names), call/chat behavior analytics from live message history, and strategy-call appointments. Use when the user asks about a specific client by name.",
  input_schema: {
    type: "object" as const,
    properties: { client_name: { type: "string" as const, description: "The client's full name or business name (partial is fine)." } },
    required: ["client_name"],
  },
};

const queryTool: Anthropic.Tool = {
  name: "query",
  description: "Run a read-only SQL SELECT against the dashboard's Postgres database. Returns rows as JSON (max 500).",
  input_schema: {
    type: "object" as const,
    properties: { sql: { type: "string" as const, description: "A single SELECT (or WITH...SELECT) statement. No semicolons." } },
    required: ["sql"],
  },
};

export type AskMessage = { role: "user" | "assistant"; content: string };
export type AskDraft = { contactName: string; channel: string; draft: string; voice: string; conversationUrl: string };
export type AskResult = { answer: string; queries: string[]; drafts?: AskDraft[] };

// Find the conversation in the agency account that best matches a lead name.
async function findConversation(leadName: string) {
  const acct = await getReplyAccount();
  if (!acct) return { error: "PMU Bookings On Demand account not configured" as const };
  const url = `https://services.leadconnectorhq.com/conversations/search?locationId=${acct.locationId}&limit=10&query=${encodeURIComponent(leadName)}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${acct.token}`, Version: "2021-04-15", Accept: "application/json" },
  });
  if (!r.ok) return { error: `conversation search failed (HTTP ${r.status})` as const };
  const j = (await r.json()) as { conversations?: Array<Record<string, unknown>> };
  const convs = j.conversations ?? [];
  if (!convs.length) return { error: `no conversation found for "${leadName}"` as const };
  const norm = (s: string) => s.toLowerCase().trim();
  const best =
    convs.find((c) => norm(String(c.fullName ?? c.contactName ?? "")).includes(norm(leadName))) ?? convs[0];
  return {
    acct,
    conversationId: String(best.id),
    contactName: String(best.fullName ?? best.contactName ?? leadName).trim(),
    channel: channelFromType(best.lastMessageType as string | undefined),
  };
}

async function runDraftReply(leadName: string, instructions: string | undefined, userEmail: string): Promise<Record<string, unknown>> {
  const found = await findConversation(leadName);
  if ("error" in found) return { error: found.error };
  const svc = createServiceClient();
  const roster = await getRoster(found.acct);
  const meUser = roster.find((u) => u.email && u.email.toLowerCase() === userEmail.toLowerCase()) ?? null;
  const agentName = meUser?.name || (userEmail ? userEmail.split("@")[0] : "our team");
  const [thread, voiceSamples, notesRow] = await Promise.all([
    getThread(found.acct, found.conversationId),
    meUser ? getVoiceSamples(found.acct, meUser.id) : Promise.resolve<string[]>([]),
    svc.from("reply_ai_notes").select("content").eq("id", 1).single(),
  ]);
  if (!thread.length) return { error: "conversation has no readable messages" };
  const { draft } = await generateDraft({
    thread,
    contactName: found.contactName,
    agentName,
    voiceSamples,
    instructions,
    standingNotes: notesRow.data?.content ?? "",
  });
  const last = thread[thread.length - 1];
  return {
    contactName: found.contactName,
    channel: found.channel,
    lastMessage: { direction: last.direction, body: last.body.slice(0, 300), at: last.dateAdded },
    draft,
    draftVoice: agentName,
    conversationUrl: `https://app.gohighlevel.com/v2/location/${found.acct.locationId}/conversations/conversations/${found.conversationId}`,
  };
}

export async function askAi(history: AskMessage[], userEmail = ""): Promise<AskResult> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const svc = createServiceClient();
  const queries: string[] = [];
  const drafts: AskDraft[] = [];

  const messages: Anthropic.MessageParam[] = history.map((m) => ({ role: m.role, content: m.content }));
  const system = SCHEMA_DOC.replace("{TODAY}", new Date().toISOString().slice(0, 10));

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system,
      messages,
      tools: [queryTool, reportTool, unreadTool, draftReplyTool],
    });

    if (msg.stop_reason !== "tool_use") {
      const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
      return { answer: text || "(no answer)", queries, drafts: drafts.length ? drafts : undefined };
    }

    messages.push({ role: "assistant", content: msg.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of msg.content) {
      if (block.type !== "tool_use") continue;
      if (block.name === "unread_conversations") {
        queries.push("[unread conversations]");
        let content: string; let isError = false;
        try {
          const acct = await getReplyAccount();
          if (!acct) throw new Error("PMU Bookings On Demand account not configured");
          const convs = await getRecentConversations(acct, 40, { unreadOnly: true });
          content = JSON.stringify(convs.map((c) => ({
            contact: c.contactName, lastMessage: c.lastMessageBody.slice(0, 150),
            direction: c.lastMessageDirection, at: c.lastMessageDate, channel: c.channel, unread: c.unreadCount,
          })));
        } catch (e) { content = `error: ${e instanceof Error ? e.message : "failed"}`; isError = true; }
        results.push({ type: "tool_result", tool_use_id: block.id, content, is_error: isError });
        continue;
      }
      if (block.name === "draft_reply") {
        const input = block.input as { lead_name?: string; instructions?: string };
        queries.push(`[draft reply: ${input.lead_name}]`);
        let content: string; let isError = false;
        try {
          const r = await runDraftReply(String(input.lead_name ?? ""), input.instructions, userEmail);
          if (typeof r.draft === "string" && typeof r.conversationUrl === "string") {
            drafts.push({
              contactName: String(r.contactName ?? ""), channel: String(r.channel ?? ""),
              draft: r.draft, voice: String(r.draftVoice ?? ""), conversationUrl: r.conversationUrl,
            });
          }
          content = JSON.stringify(r).slice(0, 30000);
        } catch (e) { content = `error: ${e instanceof Error ? e.message : "failed"}`; isError = true; }
        results.push({ type: "tool_result", tool_use_id: block.id, content, is_error: isError });
        continue;
      }
      if (block.name === "client_report") {
        const name = String((block.input as { client_name?: string }).client_name ?? "");
        queries.push(`[client report: ${name}]`);
        let content: string;
        let isError = false;
        try {
          content = JSON.stringify(await buildClientReport(name)).slice(0, 40000);
        } catch (e) {
          content = `report error: ${e instanceof Error ? e.message : "failed"}`;
          isError = true;
        }
        results.push({ type: "tool_result", tool_use_id: block.id, content, is_error: isError });
        continue;
      }
      const sql = String((block.input as { sql?: string }).sql ?? "");
      queries.push(sql);
      const { data, error } = await svc.rpc("ask_ai_query", { q: sql });
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: error ? `SQL error: ${error.message}` : JSON.stringify(data).slice(0, 30000),
        is_error: !!error,
      });
    }
    messages.push({ role: "user", content: results });
  }
  return { answer: "I ran out of query rounds before finishing — try a more specific question.", queries, drafts: drafts.length ? drafts : undefined };
}
