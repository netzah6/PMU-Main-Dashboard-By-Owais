import Anthropic from "@anthropic-ai/sdk";
import { createServiceClient } from "@/lib/supabase/server";
import { buildClientReport } from "@/lib/ghl-report";

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

CLIENT REPORT:
When the user gives a client's name or business name (alone, or asks for a
"report"), call the client_report tool with that name, then present EXACTLY
this scorecard (one line per item, plain text). Use the tool's pipeline stage
names to identify stages like "Deposit Collected", "Session Done" /
"Sessions Done", "Google Review" / "5 Star", "Declining" / "Dead" — match by
meaning, and if a stage doesn't exist say NO DATA.

Report for {Business Name} ({Owner}) — {status}, {version}

- Last Strategy Call: date of the most recent past strategyAppointments entry
  (+ the next upcoming one if any). If none: NO DATA.
- Deposits: YES if leads sit in a deposit-collected-type stage or
  ghl_lead_status.deposit_collected is true for some leads; NO if the pipeline
  has the stage but 0 leads ever reached it; NO DATA if not determinable.
- Sessions Done: count of leads in deposit-collected + session-done +
  google-review stages combined.
- Call or Chat: from behavior.outboundCalls vs behavior.outboundMessages —
  "Calls & chats", "Mostly chats", "Mostly calls", or NO DATA.
- Total Leads: pipeline.total (all opportunities in the pipeline).
- Booking %: (Sessions Done count as defined above) / Total Leads.
- Total Declining: leads in the declining-type stage.
- Declining %: declining / Total Leads.
- Dashboard Organized?: YES if leads are spread across stages; NO if ≥80% sit
  in the first one or two stages. Mention the distribution briefly.
- Call 2X In a Row?: behavior.doubleCallRatePct (calls within 20 min of each
  other to the same lead). YES if ≥30%, SOMETIMES 10–29%, NO <10%, NO DATA if
  no calls.
- Call In 24/H?: behavior.firstCallWithin24hPct (weekend leads excluded).
  YES ≥60%, SOMETIMES 25–59%, NO <25%.
- 5-7 PM?: behavior.callsBetween5and7pmPct of calls in the client's local
  timezone; if most calls are at other hours, say when they usually call.
- 3X Follow Ups?: behavior.followedUp3PlusDaysPct — of leads who never
  replied in their first week, how many got outreach on 3+ different days.
  YES ≥50%, SOMETIMES 20–49%, NO <20%.
- What's the price?: No data for now.
- Follow Script?: No data for now.

End with one short "Bottom line" sentence and list the tool's caveats
(sample size, live-fetch limits) in one line. Percentages: whole numbers.
If the tool returns an error (client not ingested), say so and show what you
CAN get from SQL (clients_master status, payments) instead.
`;

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
      tools: [queryTool, reportTool],
    });

    if (msg.stop_reason !== "tool_use") {
      const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
      return { answer: text || "(no answer)", queries };
    }

    messages.push({ role: "assistant", content: msg.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of msg.content) {
      if (block.type !== "tool_use") continue;
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
  return { answer: "I ran out of query rounds before finishing — try a more specific question.", queries };
}
