import Anthropic from "@anthropic-ai/sdk";
import { createServiceClient } from "@/lib/supabase/server";
import {
  firstUnansweredIndex, formatThreadForPrompt, getRoster, getThread, getVoiceSamples, resolveVoiceUser,
  type PmuAccount, type ThreadMessage,
} from "@/lib/ghl-conversations";
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
  nameByUserId?: Map<string, string>; // GHL user id → teammate name, to label who sent what
};

const EMOJI_RE = /\p{Extended_Pictographic}/gu;

/* The owner's complaint (2026-10-01): replies kept adding 😊 and call
   invites he never writes. A rule like "match their emoji habits" let the
   model fall back on its own habit, so the habit is now COUNTED from his
   real replies and stated as a hard rule. */
function emojiRule(agentName: string, samples: string[]): string {
  if (!samples.length) return "Do not use emojis.";
  const withEmoji = samples.filter((s) => (s.match(EMOJI_RE) ?? []).length > 0);
  const used = [...new Set(samples.flatMap((s) => s.match(EMOJI_RE) ?? []))];
  const share = withEmoji.length / samples.length;
  if (share < 0.3 || !used.length) {
    return `${agentName} used an emoji in only ${withEmoji.length} of ${samples.length} real replies — do NOT use emojis.`;
  }
  return `${agentName} used an emoji in ${withEmoji.length} of ${samples.length} real replies. Use at most ONE, and only one of these: ${used.slice(0, 8).join(" ")}. Never 😊 unless it is in that list.`;
}

function buildSystemPrompt(input: DraftInput): string {
  const { agentName, voiceSamples } = input;
  const samplesBlock = voiceSamples.length
    ? voiceSamples.map((s, i) => `Example ${i + 1}: "${s}"`).join("\n")
    : "(No past replies found for this person — write short, plain, friendly texts.)";

  return [
    `You are a drafting assistant for "PMU Bookings On Demand", an agency that runs ads and booking systems for permanent-makeup (PMU) artists. You write the next text message that ${agentName} will send to one of the agency's artist clients.`,
    "",
    "RULES THAT MATTER MOST:",
    "1. READ THE WHOLE RECENT EXCHANGE — clients often send several texts in a row, and what they mean is often in an earlier message from today or yesterday. Answer everything in the messages marked NEW, using the last 2 days for context. Never reply to only the very last line.",
    `2. VOICE — sound exactly like ${agentName} in the real replies below: same greeting style, length, punctuation and capitalization. Lines marked "Automated" are workflow texts, NOT ${agentName} — never copy their wording, emojis or calls to action. Lines marked "Agency" were really sent to the client — treat them as already said.`,
    `3. EMOJIS — ${emojiRule(agentName, voiceSamples)} Do not copy the client's emojis.`,
    "4. FACTS — only use information from the KNOWLEDGE BASE below for prices, the offer, policies, and the booking process. Never invent a price, a discount, a date, or a policy. If the knowledge base does not cover what the client asked, say what you safely can and stop.",
    "5. SCOPE — answer what the client actually said or asked, and nothing more. Do NOT invite them to a strategy call, send a booking link, pitch an offer, or add any other ask unless the client asked for a call/meeting or the note below asks for it. A short reply that answers only what was asked is correct and complete.",
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
    "- Text-message length: usually 1–2 sentences, like the real replies.",
    "- Reply in the same language the client is using.",
    "- Match the client's level of formality and warmth.",
    "- When the client is describing money pressure or hardship, acknowledge it plainly before anything else, and never follow it immediately with a new ask.",
    "- Never include placeholders like [name] — use the client's actual name if known, otherwise omit it naturally.",
  ].join("\n");
}

function buildUserPrompt(input: DraftInput): string {
  const { thread, contactName, instructions } = input;
  const extra = instructions?.trim()
    ? `\n\nExtra instruction for THIS reply (follow it): ${instructions.trim()}`
    : "";
  const waiting = firstUnansweredIndex(thread) < thread.length;
  return [
    `Conversation with ${contactName || "the client"}:`,
    "",
    formatThreadForPrompt(thread, { contactName, nameByUserId: input.nameByUserId }),
    "",
    waiting
      ? "Write the next reply we should send — it must address the NEW messages."
      : "There are no unanswered client messages. Write the message the note asks for (or a short natural follow-up if there is no note).",
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

/* One entry point for every reply the dashboard writes — the AI tab's draft
   button, the AI chat's draft tool and the Agent cards — so they all read
   the same dated conversation, the same knowledge base and team notes, and
   the same person's real voice (the logged-in teammate, else Nicolas). */
export async function draftReplyFor(opts: {
  acct: PmuAccount;
  conversationId: string;
  contactName: string;
  voiceEmail?: string | null;
  instructions?: string;
  thread?: ThreadMessage[];
}): Promise<DraftResult & { thread: ThreadMessage[]; voice: { name: string; matched: boolean; samplesUsed: number } }> {
  const svc = createServiceClient();
  const roster = await getRoster(opts.acct);
  const { user, isSelf } = resolveVoiceUser(roster, opts.voiceEmail);
  const agentName = user?.name || (opts.voiceEmail ? opts.voiceEmail.split("@")[0] : "our team");
  const [thread, voiceSamples, notesRow] = await Promise.all([
    opts.thread ? Promise.resolve(opts.thread) : getThread(opts.acct, opts.conversationId),
    user ? getVoiceSamples(opts.acct, user.id) : Promise.resolve<string[]>([]),
    svc.from("reply_ai_notes").select("content").eq("id", 1).single(),
  ]);
  const { draft, model } = await generateDraft({
    thread,
    contactName: opts.contactName,
    agentName,
    voiceSamples,
    instructions: opts.instructions,
    standingNotes: notesRow.data?.content ?? "",
    nameByUserId: new Map(roster.map((u) => [u.id, u.name])),
  });
  return { draft, model, thread, voice: { name: agentName, matched: isSelf, samplesUsed: voiceSamples.length } };
}
