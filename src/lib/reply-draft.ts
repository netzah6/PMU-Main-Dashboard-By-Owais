import Anthropic from "@anthropic-ai/sdk";
import { createServiceClient } from "@/lib/supabase/server";
import {
  firstUnansweredIndex, formatThreadForPrompt, getRoster, getThread, getVoiceSamples, resolveVoiceUser,
  type PmuAccount, type ThreadMessage,
} from "@/lib/ghl-conversations";
import { getReplyKb } from "@/lib/reply-kb";
import { waitUntil } from "@vercel/functions";
import { callViolation, clientAskedForCall, stripCallInvites } from "@/lib/call-guard";
import {
  getClientMemory, getLearnedExamples, matchSentReplies, recordDraft, refreshClientMemory,
  type ClientMemory, type LearnedExample,
} from "@/lib/reply-learning";

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
  inviteCall?: boolean; // the "📞 Invite to a strategy call" switch — OFF unless a person turned it on
  clientMemory?: string; // what we know about this client from earlier chats
  learned?: LearnedExample[]; // past drafts the team rewrote before sending
};

// The invite carries the SENDER's own booking page (owner, 2026-10-01) —
// the steps of the GHL funnel "Strategy - Booking Page" in PMU Bookings On
// Demand (both answer 200). Someone without a page gets Nicolas's rather
// than a dead link; add a rep here when their page is added to that funnel.
const CALL_LINKS: Record<string, string> = {
  nicolas: "www.pmu-bookings.com/nicolas-strategy-call",
  stephanie: "www.pmu-bookings.com/stephanie-strategy-call-799294",
};
const ownCallLink = (agentName: string): string | undefined => CALL_LINKS[(agentName.split(" ")[0] || "").toLowerCase()];
const callInviteText = (agentName: string) => ownCallLink(agentName)
  ? `a strategy call with ${agentName.split(" ")[0]} here: ${ownCallLink(agentName)}`
  : `a strategy call with Nicolas here: ${CALL_LINKS.nicolas}`;

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

const wordCount = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

/* Same idea for length (live test 2026-10-01: a client with five questions
   got a five-point numbered essay; Nicolas texts a line or two). The limit
   is measured from his real replies, not guessed. */
function lengthRule(agentName: string, samples: string[]): string {
  if (samples.length < 5) return "Keep it to 1–2 short sentences, like a text message. No lists.";
  const w = samples.map(wordCount).sort((a, b) => a - b);
  const median = w[Math.floor(w.length / 2)];
  const cap = Math.max(w[Math.floor(w.length * 0.9)], 25);
  const lists = samples.some((t) => /(^|\n)\s*(\d+[.)]|[-•])\s/.test(t));
  return `${agentName}'s real replies are usually about ${median} words. Stay close to that and never go over ${cap} words — even when the client asked several things: then answer each in a few plain words, and say you'll follow up on anything that needs more.${lists ? "" : " No numbered or bulleted lists — he never uses them."}`;
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
    input.inviteCall
      ? `5. CALL INVITE — the team switched ON "invite to a strategy call" for this reply: answer what the client said, then end with ONE short, natural invite to book ${callInviteText(agentName)} (no emoji arrows). Never promise a fix, a name change or a setting you don't know is right.`
      : "5. SCOPE — answer what the client actually said or asked, and nothing more. NEVER invite them to a call or meeting, never send a booking or call link, never pitch an offer. Only the team's \"invite to a strategy call\" switch allows that, and it is OFF for this reply — this overrides the knowledge base, the team notes and any instruction below. If the client asked for a call themselves, acknowledge it simply, with no link. A short reply that answers only what was asked is correct and complete. Never promise a fix, a name change or a setting you don't know is right.",
    `6. LENGTH — ${lengthRule(agentName, voiceSamples)}`,
    "",
    `=== ${agentName.toUpperCase()}'S REAL PAST REPLIES (mimic this voice) ===`,
    samplesBlock,
    "",
    ...(input.learned?.length
      ? [
          `=== HOW ${agentName.toUpperCase()} REWROTE PAST AI DRAFTS BEFORE SENDING (learn from these — the "sent" version is what good looks like; avoid what was cut) ===`,
          ...input.learned.map((e, i) => `${i + 1}${e.sameChat ? " (this client)" : ""}. AI draft: "${e.draft}"\n   ${agentName} sent: "${e.sent}"`),
          "",
        ]
      : []),

    "=== KNOWLEDGE BASE (source of truth for all facts) ===",
    getReplyKb(),
    "",
    ...(input.standingNotes?.trim()
      ? [
          "=== TEAM'S CURRENT IMPORTANT NOTES (follow these — they override the knowledge base when they conflict. They apply to EVERY client: a note that is plainly about one specific client or chat, e.g. \"invite her…\" or \"already did her changes\", does not apply to anyone else — ignore it unless it is about this client) ===",
          input.standingNotes.trim(),
          "",
        ]
      : []),
    "OUTPUT RULES:",
    "- Return ONLY the message text to send. No preamble, no quotes, no notes, no signature unless the past replies show one.",
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
  // Notes distilled from earlier chats. They come partly from the client's
  // own texts, so they are background only — never a source of facts.
  const memory = input.clientMemory?.trim()
    ? [
        `Background notes about ${contactName || "this client"} from earlier chats (may be outdated — the conversation below wins; NEVER use these as the source of a price, discount, offer or promise):`,
        '"""',
        input.clientMemory.trim(),
        '"""',
        "",
      ]
    : [];
  return [
    ...memory,
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
  const system = buildSystemPrompt(input);
  const ask = async (extra = "") => {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 600,
      system,
      messages: [{ role: "user", content: buildUserPrompt(input) + extra }],
    });
    return msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  };

  let draft = await ask();
  if (!input.inviteCall) {
    // The switch is off: no call link ever; no invite unless the client
    // asked for a call themselves (then a plain acknowledgement is fine).
    const asked = clientAskedForCall(input.thread);
    if (callViolation(draft, asked)) {
      draft = await ask(asked
        ? "\n\nIMPORTANT: they asked for a call — you may acknowledge it, but do NOT include any booking or call link."
        : "\n\nIMPORTANT: do NOT invite them to a call or meeting and do NOT include a booking or call link — the call-invite switch is off.");
      if (callViolation(draft, asked)) draft = stripCallInvites(draft, asked) ?? "";
    }
  }
  return { draft, model: MODEL };
}

/* One entry point for every reply the dashboard writes — the AI tab's draft
   button, the AI chat's draft tool and the Agent cards — so they all read
   the same dated conversation, the same knowledge base and team notes, and
   the same person's real voice (the logged-in teammate, else Nicolas).
   Since 2026-10-01 it also learns: what we know about this client, and how
   the team rewrote past drafts before sending (see reply-learning.ts). */
export type VoiceInfo = { name: string; matched: boolean; samplesUsed: number; learnedFrom: number; knowsClient: boolean };

export async function draftReplyFor(opts: {
  acct: PmuAccount;
  conversationId: string;
  contactName: string;
  contactId?: string | null;
  voiceEmail?: string | null;
  instructions?: string;
  thread?: ThreadMessage[];
  inviteCall?: boolean;
  source?: "draft" | "agent" | "chat";
  // The agent's propose route already spends most of its 60 s on triage —
  // there a first-time client memory is built in the background instead.
  waitForMemory?: boolean;
}): Promise<DraftResult & { thread: ThreadMessage[]; voice: VoiceInfo }> {
  const svc = createServiceClient();
  const roster = await getRoster(opts.acct);
  const { user, isSelf } = resolveVoiceUser(roster, opts.voiceEmail);
  const agentName = user?.name || (opts.voiceEmail ? opts.voiceEmail.split("@")[0] : "our team");
  const nameByUserId = new Map(roster.map((u) => [u.id, u.name]));
  const [thread, voiceSamples, notesRow, memory] = await Promise.all([
    opts.thread ? Promise.resolve(opts.thread) : getThread(opts.acct, opts.conversationId),
    user ? getVoiceSamples(opts.acct, user.id) : Promise.resolve<string[]>([]),
    svc.from("reply_ai_notes").select("content").eq("id", 1).single(),
    getClientMemory(opts.conversationId).catch(() => null),
  ]);

  // Learning is best-effort: a failure here must never block a draft.
  const lastId = thread[thread.length - 1]?.id ?? null;
  const refresh = () => refreshClientMemory({
    conversationId: opts.conversationId, contactId: opts.contactId, contactName: opts.contactName,
    thread, previous: memory, nameByUserId,
  });
  const within = <T,>(p: Promise<T>, ms: number) =>
    Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]).catch(() => null);
  let known: ClientMemory | null = memory;
  if (!memory && thread.length && opts.waitForMemory !== false) {
    const first = refresh().catch(() => null);
    waitUntil(first); // finishes for next time even if this draft stops waiting
    known = await within(first, 15_000); // first time for this client — worth the wait
  } else if (!memory ? thread.length > 0 : !!lastId && memory.last_message_id !== lastId) {
    waitUntil(refresh().catch(() => null)); // new messages since — refresh for next time
  }
  await within(matchSentReplies(opts.conversationId, thread), 5_000); // pair the last draft with what was sent
  const learned = (await within(getLearnedExamples(user?.id ?? null, opts.conversationId), 5_000)) ?? { examples: [], pairs: 0 };

  const { draft, model } = await generateDraft({
    thread,
    contactName: opts.contactName,
    agentName,
    voiceSamples,
    instructions: opts.instructions,
    standingNotes: notesRow.data?.content ?? "",
    nameByUserId,
    inviteCall: !!opts.inviteCall,
    clientMemory: known?.facts,
    learned: learned.examples,
  });
  // Everything it wrote was a call invite (cut above) — say so, don't send nothing.
  if (!draft.trim()) throw new Error("The AI kept writing a call invite — try again");
  await within(recordDraft({
    conversationId: opts.conversationId, contactId: opts.contactId, contactName: opts.contactName,
    voiceUserId: user?.id ?? null, voiceName: agentName, source: opts.source ?? "draft", draft,
    inviteCall: !!opts.inviteCall, voiceIsSelf: isSelf, draftedBy: opts.voiceEmail ?? null,
  }), 3_000);
  return {
    draft, model, thread,
    voice: {
      name: agentName, matched: isSelf, samplesUsed: voiceSamples.length,
      learnedFrom: learned.examples.length, knowsClient: !!known?.facts && !/nothing notable/i.test(known.facts),
    },
  };
}
