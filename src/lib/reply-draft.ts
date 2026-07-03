import Anthropic from "@anthropic-ai/sdk";
import type { ThreadMessage } from "@/lib/ghl-conversations";
import { getReplyKb } from "@/lib/reply-kb";

// Sensible, cost-effective default; override with ANTHROPIC_MODEL if desired.
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

export type DraftInput = {
  thread: ThreadMessage[];
  contactName: string;
  agentName: string; // the team member the reply should sound like
  voiceSamples: string[]; // that person's real past replies
  instructions?: string; // optional extra guidance from the user for this reply
  standingNotes?: string; // team-wide notes considered on EVERY draft (from the Notes panel)
};

function buildSystemPrompt(input: DraftInput): string {
  const { agentName, voiceSamples } = input;
  const samplesBlock = voiceSamples.length
    ? voiceSamples.map((s, i) => `Example ${i + 1}: "${s}"`).join("\n")
    : "(No past replies found for this person — use a warm, professional, concise tone.)";

  return [
    `You are a drafting assistant for "PMU Bookings On Demand", an agency that books appointments for permanent-makeup (PMU) artists. You write the next SMS reply that ${agentName} will send to a prospective client.`,
    "",
    "TWO RULES THAT MATTER MOST:",
    `1. VOICE — sound exactly like ${agentName}. Match the greeting style, sentence length, punctuation, capitalization, and emoji habits shown in their real past replies below. Do not sound like a corporate bot.`,
    "2. FACTS — only use information from the KNOWLEDGE BASE below for prices, the offer, policies, and the booking process. Never invent a price, a discount, a date, or a policy. If the knowledge base does not cover what the client asked and you cannot answer safely, write a short reply that moves the conversation forward (e.g. offer a quick call) instead of guessing.",
    "",
    `=== ${agentName.toUpperCase()}'S REAL PAST REPLIES (mimic this voice) ===`,
    samplesBlock,
    "",
    "=== KNOWLEDGE BASE (source of truth for all facts) ===",
    getReplyKb(),
    "",
    ...(input.standingNotes?.trim()
      ? [
          "=== TEAM'S CURRENT IMPORTANT NOTES (follow these — they override the knowledge base when they conflict) ===",
          input.standingNotes.trim(),
          "",
        ]
      : []),
    "OUTPUT RULES:",
    "- Return ONLY the message text to send. No preamble, no quotes, no notes, no signature unless the past replies show one.",
    "- Keep it SMS-appropriate length unless the conversation clearly calls for more.",
    "- Reply in the same language the client is using.",
    "- Never include placeholders like [name] — use the client's actual name if known, otherwise omit it naturally.",
  ].join("\n");
}

function buildUserPrompt(input: DraftInput): string {
  const { thread, contactName, instructions } = input;
  const convo = thread
    .map((m) => `${m.direction === "inbound" ? `${contactName || "Client"}` : "Us"}: ${m.body}`)
    .join("\n");
  const extra = instructions?.trim()
    ? `\n\nExtra instruction for THIS reply (follow it): ${instructions.trim()}`
    : "";
  return [
    `Conversation so far with ${contactName || "the client"} (oldest first):`,
    "",
    convo || "(No prior messages.)",
    "",
    "Write the next reply we should send.",
    extra,
  ].join("\n");
}

export type DraftResult = { draft: string; model: string };

export async function generateDraft(input: DraftInput): Promise<DraftResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  const client = new Anthropic({ apiKey });

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 600,
    system: buildSystemPrompt(input),
    messages: [{ role: "user", content: buildUserPrompt(input) }],
  });

  const draft = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  return { draft, model: MODEL };
}
