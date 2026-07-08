import Anthropic from "@anthropic-ai/sdk";
import { createServiceClient } from "@/lib/supabase/server";

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
- GHL data exists mainly for live V3/V2.3 clients (the tracked roster). If a
  client has no ghl_* rows, say their sub-account isn't being ingested — not
  that they have zero leads.
- Answer in plain text: short paragraphs, "-" bullets, no markdown tables or
  headers. Round percentages to whole numbers. Always state the time window.
- Today's date is {TODAY}.
`;

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
export type AskResult = { answer: string; queries: string[] };

export async function askAi(history: AskMessage[]): Promise<AskResult> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const svc = createServiceClient();
  const queries: string[] = [];

  const messages: Anthropic.MessageParam[] = history.map((m) => ({ role: m.role, content: m.content }));
  const system = SCHEMA_DOC.replace("{TODAY}", new Date().toISOString().slice(0, 10));

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system,
      messages,
      tools: [queryTool],
    });

    if (msg.stop_reason !== "tool_use") {
      const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
      return { answer: text || "(no answer)", queries };
    }

    messages.push({ role: "assistant", content: msg.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of msg.content) {
      if (block.type !== "tool_use") continue;
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
  return { answer: "I ran out of query rounds before finishing — try a more specific question.", queries };
}
