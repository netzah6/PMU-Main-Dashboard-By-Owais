import Anthropic from "@anthropic-ai/sdk";
import { createServiceClient } from "@/lib/supabase/server";
import { buildClientReport, renderClientReport } from "@/lib/ghl-report";
import { getReplyAccount, getRecentConversations, getThread, getRoster, getVoiceSamples, channelFromType } from "@/lib/ghl-conversations";
import { generateDraft } from "@/lib/reply-draft";
import { resolveAccount, readThread, scanMessages, pipelineContacts } from "@/lib/ask-conversations";

// "Ask AI" — chat over the dashboard's client/lead data. The model writes
// SELECT queries; they run through the ask_ai_query() RPC, which forces a
// read-only transaction, single statement, 8s timeout, 500-row cap.

const MODEL = "claude-sonnet-4-5";
const MAX_TOOL_ROUNDS = 12; // chat audits need: scan inbound, scan outbound, pipeline, answer

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
- "Sessions done" is NOT tracked as a field. In SQL the closest signals are
  booked=true / deposit_collected=true in ghl_lead_status — but if the user
  wants to know who ACTUALLY had a session or paid, read the chats
  (search_messages), because the truth is in what people wrote, not in a flag.
- GHL data covers all live/paused clients whose sub-account name matches the
  master sheet. If a client has no ghl_* rows, say their sub-account isn't
  being ingested yet (first sync may still be running) — not that they have
  zero leads.
- Answer in plain text: short paragraphs, "-" bullets, no markdown tables or
  headers. Round percentages to whole numbers. Always state the time window.
- Today's date is {TODAY}.

READING ACTUAL CHATS — read_thread / search_messages / pipeline_contacts:
The SQL tables hold counts and the LATEST message only. Any question about
what someone actually said, agreed to, promised or confirmed needs these
tools. Reach for them instead of answering "not tracked".

- "Did {client} ask to pause / go on vacation / change their plan?", "what
  did {client} say about X?", "why did {lead} cancel?" → read_thread with
  contact_name = the person. Leave client_name EMPTY when it's one of our
  artists talking to our team (that lives in the agency account). Set
  client_name when it's one of THEIR leads.
- "Check {client}'s chats and find who paid a deposit / who had their session
  but isn't marked" → search_messages with client_name = {client} and several
  regex phrasings, then pipeline_contacts for the same client, and report the
  people whose chat says one thing and whose stage says another. Business-side
  confirmations ("I got it", "I received your payment") are stronger evidence
  than a lead saying "paid" — a lead's "paid" is often "how much do I pay?".
  Run one pass with direction inbound and one with outbound when it matters.
- Quote the decisive line and its date. A one-line quote is worth more than a
  paragraph of summary, and it lets the team verify you.
- Report coverage honestly: repeat the tool's coverageNote, and say plainly
  that anything agreed by phone or in person is invisible here, so a count
  from chat is a floor, not a total.
- These read live message history and are slower than SQL. Use them when the
  question needs them; don't scan for something a SELECT can answer.

REPLIES (merged from the old AI Replies tab):
- "what's unread?" / "who's waiting for a reply?" → unread_conversations,
  list contact + last message + how long ago, newest first.
- "reply to {name}" / "draft a message for {name}" → draft_reply. If the
  user's message contains "conversation {id}" (from clicking a chat in the
  sidebar), pass it as conversation_id. The draft
  is shown to the user in a special card with copy/open buttons — do NOT
  repeat the draft text in your answer. Reply with ONE short line, e.g.
  'Here's a draft for {contact} in {draftVoice}'s style — use the buttons
  below to copy it and open the chat.' Mention the lead's last message
  briefly if helpful. NEVER claim the message was sent — the team copies and
  sends it in GHL. Pass the user's phrasing hints via instructions.

CLIENT REPORT:
When the user gives a client's name or business name (alone, or asks for a
"report" / "performance report"), call the client_report tool with that name.
The report card is rendered by the SERVER from computed data and shown to the
user directly — you never see the numbers and must never produce them.
- On success, reply with ONE short line: "Here's the report for {business}."
- On error, state the error plainly and stop.
- NEVER write a report card, pipeline breakdown, scorecard, or any metric
  yourself — not from memory, not from earlier messages in this chat, not
  from SQL. A report without a client_report call in this turn is fabricated,
  and fabricated numbers about a client's business are worse than no answer.
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
      conversation_id: { type: "string" as const, description: "Exact GHL conversation id, when the user's message includes one (e.g. from clicking a chat in the sidebar). Takes precedence over name search." },
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

const readThreadTool: Anthropic.Tool = {
  name: "read_thread",
  description:
    "Read the actual message history with one person. Use whenever a question turns on what someone SAID rather than a number — 'did X ask to pause', 'what did she say about her trip', 'why did they cancel', 'what was agreed'. Omit client_name to read the agency's own chats with a client (the team talking to an artist). Give client_name to read inside that client's sub-account instead (the artist talking to their own leads). Returns messages oldest-first; direction 'inbound' means the other person wrote it, 'outbound' means our side did.",
  input_schema: {
    type: "object" as const,
    properties: {
      contact_name: { type: "string" as const, description: "Who the conversation is with — name, email or phone. Partial is fine." },
      client_name: { type: "string" as const, description: "Only when reading inside a client's own sub-account. Leave empty for the agency account." },
    },
    required: ["contact_name"],
  },
};

const searchMessagesTool: Anthropic.Tool = {
  name: "search_messages",
  description:
    "Search the wording of every conversation in an account and return the matches with the pipeline stage each person currently sits in. This is the tool for auditing what the pipeline is missing — deposits that were paid but never marked, people who showed up, promises made — because none of that is a field anywhere, it only exists in what people wrote. Pass several regex alternatives to cover phrasing. Results include a coverage note; repeat it honestly rather than implying full coverage.",
  input_schema: {
    type: "object" as const,
    properties: {
      contains: {
        type: "array" as const,
        items: { type: "string" as const },
        description: "Case-insensitive regex patterns, e.g. ['i (just )?sent (it|the deposit)','got your (deposit|payment)','i.?m here']. Prefer several specific phrases over one vague word.",
      },
      client_name: { type: "string" as const, description: "Client whose sub-account to search. Leave empty to search the agency's own account." },
      direction: { type: "string" as const, enum: ["inbound", "outbound", "any"], description: "'inbound' = only what the lead/client wrote, 'outbound' = only what our side wrote (business confirmations are often the harder evidence). Default any." },
      max_contacts: { type: "number" as const, description: "How many of the most recently active conversations to scan. Default 200, max 400." },
    },
    required: ["contains"],
  },
};

const pipelineContactsTool: Anthropic.Tool = {
  name: "pipeline_contacts",
  description: "List who is sitting in each pipeline stage for a client, by name. Use together with search_messages to work out which people are in the wrong stage.",
  input_schema: {
    type: "object" as const,
    properties: { client_name: { type: "string" as const, description: "The client whose pipeline to list." } },
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
export type AskResult = { answer: string; queries: string[]; drafts?: AskDraft[]; reports?: string[] };

// Find the conversation in the agency account that best matches a lead name
// (or fetch it directly when an exact conversation id is given).
async function findConversation(leadName: string, conversationId?: string) {
  const acct = await getReplyAccount();
  if (!acct) return { error: "PMU Bookings On Demand account not configured" as const };
  if (conversationId) {
    const r = await fetch(`https://services.leadconnectorhq.com/conversations/${conversationId}`, {
      headers: { Authorization: `Bearer ${acct.token}`, Version: "2021-04-15", Accept: "application/json" },
    });
    if (r.ok) {
      const c = (await r.json()) as Record<string, unknown>;
      return {
        acct,
        conversationId,
        contactId: (c.contactId as string) ?? null,
        contactName: String(c.fullName ?? c.contactName ?? c.email ?? c.phone ?? leadName ?? "Unknown").trim(),
        channel: channelFromType((c.lastMessageType ?? (c.conversation as Record<string, unknown>)?.lastMessageType) as string | undefined),
      };
    }
    // fall through to name search if the direct fetch failed
  }
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
    contactId: (best.contactId as string) ?? null,
    contactName: String(best.fullName ?? best.contactName ?? leadName).trim(),
    channel: channelFromType(best.lastMessageType as string | undefined),
  };
}

async function runDraftReply(leadName: string, instructions: string | undefined, userEmail: string, conversationId?: string): Promise<Record<string, unknown>> {
  const found = await findConversation(leadName, conversationId);
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
    // Open the contact's detail page — the reliable deep-link to their chat
    // (the /conversations/conversations/{id} route often lands on the inbox,
    // not this thread). Falls back to the conversation URL if no linked contact.
    conversationUrl: found.contactId
      ? `https://app.gohighlevel.com/v2/location/${found.acct.locationId}/contacts/detail/${found.contactId}`
      : `https://app.gohighlevel.com/v2/location/${found.acct.locationId}/conversations/conversations/${found.conversationId}`,
  };
}

export async function askAi(history: AskMessage[], userEmail = "", isAdmin = false): Promise<AskResult> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const svc = createServiceClient();
  const queries: string[] = [];
  const drafts: AskDraft[] = [];
  const reports: string[] = [];

  const messages: Anthropic.MessageParam[] = history.map((m) => ({ role: m.role, content: m.content }));
  const system = SCHEMA_DOC.replace("{TODAY}", new Date().toISOString().slice(0, 10));

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system,
      messages,
      tools: [queryTool, reportTool, unreadTool, draftReplyTool, readThreadTool, searchMessagesTool, pipelineContactsTool],
    });

    if (msg.stop_reason !== "tool_use") {
      const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
      return { answer: text || "(no answer)", queries, drafts: drafts.length ? drafts : undefined, reports: reports.length ? reports : undefined };
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
          let convs = await getRecentConversations(acct, 40, { unreadOnly: true });
          // Team members only see chats assigned to THEM (email → GHL user).
          if (!isAdmin) {
            const roster = await getRoster(acct);
            const meU = roster.find((u) => u.email && u.email === userEmail.toLowerCase());
            convs = meU ? convs.filter((c) => c.assignedTo === meU.id) : [];
          }
          content = JSON.stringify(convs.map((c) => ({
            contact: c.contactName, lastMessage: c.lastMessageBody.slice(0, 150),
            direction: c.lastMessageDirection, at: c.lastMessageDate, channel: c.channel, unread: c.unreadCount,
          })));
        } catch (e) { content = `error: ${e instanceof Error ? e.message : "failed"}`; isError = true; }
        results.push({ type: "tool_result", tool_use_id: block.id, content, is_error: isError });
        continue;
      }
      if (block.name === "draft_reply") {
        const input = block.input as { lead_name?: string; conversation_id?: string; instructions?: string };
        queries.push(`[draft reply: ${input.lead_name}]`);
        let content: string; let isError = false;
        try {
          const r = await runDraftReply(String(input.lead_name ?? ""), input.instructions, userEmail, input.conversation_id || undefined);
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
      if (block.name === "read_thread" || block.name === "search_messages" || block.name === "pipeline_contacts") {
        const input = block.input as { contact_name?: string; client_name?: string; contains?: string[]; direction?: string; max_contacts?: number };
        const where = input.client_name ? `${input.client_name}'s account` : "agency account";
        queries.push(
          block.name === "read_thread" ? `[read chat: ${input.contact_name} — ${where}]`
            : block.name === "search_messages" ? `[search chats: ${(input.contains ?? []).join(" | ").slice(0, 80)} — ${where}]`
              : `[pipeline: ${input.client_name}]`,
        );
        let content: string; let isError = false;
        try {
          const acct = await resolveAccount(input.client_name);
          if ("error" in acct) throw new Error(acct.error);
          const r = block.name === "read_thread"
            ? await readThread(acct, String(input.contact_name ?? ""))
            : block.name === "search_messages"
              ? await scanMessages(acct, {
                contains: input.contains ?? [],
                maxContacts: input.max_contacts,
                direction: input.direction === "inbound" || input.direction === "outbound" ? input.direction : "any",
              })
              : await pipelineContacts(acct);
          content = JSON.stringify(r).slice(0, 60000);
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
          const data = await buildClientReport(name);
          const rendered = !data.error ? renderClientReport(data) : null;
          if (rendered) {
            // The report card the user sees is THIS string, assembled in code.
            // The model gets no numbers to transcribe — it was caught inventing
            // owner names and lead counts when asked to copy them — only enough
            // context for a one-line handoff.
            reports.push(rendered);
            const c = data.client as { owner?: string; business?: string };
            content = JSON.stringify({
              rendered: true,
              business: c.business,
              owner: c.owner,
              note: "The full report card is already displayed to the user, exactly as computed. Reply with ONE short line (e.g. \"Here's the report for {business}.\") and do NOT restate, summarize or invent any numbers — they are all in the card.",
            });
          } else {
            content = `report error: ${String(data.error ?? "could not render report")}`;
            isError = true;
          }
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
  return { answer: "I ran out of query rounds before finishing — try a more specific question.", queries, drafts: drafts.length ? drafts : undefined, reports: reports.length ? reports : undefined };
}
