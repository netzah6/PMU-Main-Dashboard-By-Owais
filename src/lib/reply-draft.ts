import Anthropic from "@anthropic-ai/sdk";
import { createServiceClient } from "@/lib/supabase/server";
import {
  firstUnansweredIndex, formatThreadForPrompt, getRoster, getThread, getVoiceSamples, resolveVoiceUser,
  type PmuAccount, type ThreadMessage,
} from "@/lib/ghl-conversations";
import { getReplyKb } from "@/lib/reply-kb";
import { waitUntil } from "@vercel/functions";
import { callViolation, clientAskedForCall, stripCallInvites } from "@/lib/call-guard";
import { getWinbackForContact, winbackContext, winbackInstructions, type WinbackContext } from "@/lib/winback";
import {
  getClientMemory, getLearnedExamples, matchSentReplies, recordDraft, refreshClientMemory, withoutSecrets,
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
  revise?: boolean; // editing an earlier draft: keep all of it, length may grow
  /** 🔁 A win-back chat: the former client we texted first, the approved offer and where the flow stands. */
  winback?: WinbackContext;
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

/* COMPLETE MIRRORING (owner, 2026-10-12): the reply matches the CLIENT's
   latest message in every way — energy, formality, emojis, layout and
   sign-off. "Nicolas" at the bottom of a reply to a casual text was the
   complaint: a sign-off exists only when the client signed off. The
   client's own habits are measured from their NEW messages so the rule is
   stated as facts, not left to the model's own habit. */
function clientVibe(thread: ThreadMessage[], agentName: string): string {
  const inbound = thread.filter((m) => m.direction === "inbound").map((m) => m.body ?? "");
  const latest = inbound.slice(-3).join("\n").trim();
  if (!latest) return "No client message to mirror — write one short, plain, friendly line.";
  const emojis = [...new Set(latest.match(EMOJI_RE) ?? [])];
  const exclaim = (latest.match(/!/g) ?? []).length;
  const lines = latest.split("\n").map((l) => l.trim()).filter(Boolean);
  const greeting = /^(hi|hey|hello|good (morning|afternoon|evening))\b/i.test(lines[0] ?? "");
  const last = lines[lines.length - 1] ?? "";
  const prev = lines[lines.length - 2] ?? "";
  const signOffWord = /^(thanks?|thank you|regards|best|cheers|sincerely|warmly|talk soon)[,!. ]*/i;
  const signedOff = signOffWord.test(last) || (signOffWord.test(prev) && wordCount(last) <= 3) || (wordCount(last) <= 2 && /^[A-Z][a-z]+/.test(last) && lines.length >= 2);
  const formal = /\b(regards|sincerely|dear|kindly|please advise|appreciate your)\b/i.test(latest) && !emojis.length;
  const parts: string[] = [];
  parts.push(emojis.length
    ? `EMOJIS: the client used ${emojis.join(" ")} — match that energy with a similar amount of emojis (${emojis.join(" ")} or close in spirit). Not more than they did.`
    : "EMOJIS: the client used none — use none.");
  parts.push(exclaim >= 2 ? "ENERGY: excited (several '!') — be warm and upbeat, '!' is fine." : exclaim === 1 ? "ENERGY: friendly — at most one '!'." : "ENERGY: calm — no exclamation marks.");
  parts.push(formal ? "REGISTER: formal and polite — full sentences, no slang, no emojis." : "REGISTER: casual, texty, like a peer.");
  parts.push(greeting ? `GREETING: they opened with a greeting line ("${lines[0].slice(0, 40)}") — open with a greeting line to them, with their first name.` : "GREETING: they opened without a greeting — do the same, start straight in.");
  parts.push(signedOff
    ? `SIGN-OFF: they closed with a sign-off ("${prev && signOffWord.test(prev) ? prev : last}"${signOffWord.test(prev) ? ` / "${last}"` : ""}) — close the same way: the same kind of closing word, then "${agentName.split(" ")[0]}" on its own line.`
    : `SIGN-OFF: they did NOT sign off — NO closing line and NO name at the end. Never add "${agentName.split(" ")[0]}" on its own.`);
  parts.push(lines.length >= 3 ? `LAYOUT: ${lines.length} short lines/paragraphs — answer in the same shape and order.` : lines.length === 2 ? "LAYOUT: two short parts — reply in two short parts." : "LAYOUT: one line — reply in one line.");
  return parts.join(" ");
}

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

/* 🔁 Win-back replies continue the agreed flow (owner, 2026-10-20): we texted
   her first and asked her brow price; her answer opens a sales conversation,
   so a bare "got it" is wrong. React → offer → one forward question. The
   normal SCOPE rule (never pitch) is replaced by this one for these chats;
   the call switch still decides whether the closing question is a call. */
export function winbackRule(w: WinbackContext, callInvite: string | null): string {
  const first = w.name.split(" ")[0] || "she";
  const math = w.price && w.offer === "pps"
    ? ` She charges about $${w.price}: say what $60 is next to that (about ${Math.max(1, Math.round((60 / w.price) * 100))}% of one appointment, the rest is hers).`
    : "";
  const pitch = w.offer === "pps"
    ? `Pay-per-appointment, in plain words: no monthly fee; her new clients book with a $50 deposit (that covers us) and she pays $60 only when a client actually shows up for the first session; touch-ups, upsells and referrals stay 100% hers.${math}`
    : w.offer === "monthly"
    ? "The monthly program, upgraded since she left: AI that books clients for her 24/7, deposits collected for her, new funnels. NEVER write a monthly price — say you'll go over the numbers together."
    : "No program is approved for her yet: name NO program and NO price. Ask how many new brow clients a month would feel great right now.";
  const close = callInvite
    ? `end with ONE short, natural invite to book ${callInvite} (no emoji arrows)`
    : w.offer
    ? 'end with ONE forward question — "want me to send you the details?" or "want me to show you how it works?" — no call, no meeting, no link'
    : 'end with that one question about how many new clients a month she\'d want — no call, no meeting, no link';
  if (w.stage === "declined") {
    return `5. WIN-BACK, DECLINED — ${first} is a former client we texted first and she has said no. Thank her warmly in one or two lines, leave the door open, and stop. No offer, no price, no call, no link.`;
  }
  if (w.stage === "offer_presented") {
    return `5. WIN-BACK, OFFER ON THE TABLE — ${first} is a former client we texted first and we have already described the offer. Answer exactly what she asked or objected to, using only these facts: ${pitch} Then ${close}. Never promise results or a number of clients.`;
  }
  return `5. WIN-BACK, SHE ANSWERED OUR OPENER — ${first} is a former client we texted first ("what are you charging for brows these days?"). Her reply is the start of a sales conversation, NOT a question to close with "got it". The reply must do three things in order: (a) one short line reacting to what she said — warm, specific, using her number if she gave one; (b) the offer: ${pitch} (c) ${close}. Never promise results or a number of clients. If instead she says she's busy and fully booked, be happy for her and leave the door open in one line; if she mentions money pressure, acknowledge it first — the no-monthly-fee part is the answer to it, not a new ask.`;
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
    `3. COMPLETE MIRRORING — the reply must match the CLIENT's latest message in vibe and form, measured from what they wrote: ${clientVibe(input.thread, agentName)} This rule beats ${agentName}'s own habits (${emojiRule(agentName, voiceSamples).replace(/^Do not use emojis\.$/, "no emojis by default")}) whenever they differ: an excited client with emojis gets emojis back; a formal "Regards, Sara" gets a formal "Regards, ${agentName.split(" ")[0]}" back; a plain one-liner gets a plain one-liner with no name at the end.`,
    "4. FACTS — only use information from the KNOWLEDGE BASE below for prices, the offer, policies, and the booking process. Never invent a price, a discount, a date, or a policy. If the knowledge base does not cover what the client asked, say what you safely can and stop.",
    input.winback
      ? winbackRule(input.winback, input.inviteCall ? callInviteText(agentName) : null)
      : input.inviteCall
      ? `5. CALL INVITE — the team switched ON "invite to a strategy call" for this reply: answer what the client said, then end with ONE short, natural invite to book ${callInviteText(agentName)} (no emoji arrows). Never promise a fix, a name change or a setting you don't know is right.`
      : "5. SCOPE — answer what the client actually said or asked, and nothing more. NEVER invite them to a call or meeting, never send a booking or call link, never pitch an offer. Only the team's \"invite to a strategy call\" switch allows that, and it is OFF for this reply — this overrides the knowledge base, the team notes and any instruction below. If the client asked for a call themselves, acknowledge it simply, with no link. A short reply that answers only what was asked is correct and complete. Never promise a fix, a name change or a setting you don't know is right.",
    input.revise
      // A revision must never lose a point the team asked for just to stay
      // short (owner, 2026-10-04: the 9–5 hours vanished on an edit).
      ? "6. LENGTH — this is a REVISION of an earlier draft: keep every point the earlier notes asked for and every sentence the change doesn't touch. It may be longer than usual; still no filler."
      : input.winback && input.winback.stage !== "declined"
      ? "6. LENGTH — this reply carries the offer: 2–4 short lines, under 70 words, no lists. Still a text message, not an email."
      : `6. LENGTH — ${lengthRule(agentName, voiceSamples)}`,
    // Owner, 2026-10-08 (Sara's "Hi Nicholas! … Thank you so much, Sara"
    // message got a flat text back): the reply must LOOK like the client's
    // message, not just answer it.
    input.winback && input.winback.stage !== "declined"
      ? "7. MIRROR THE CLIENT'S TONE, NOT HER LENGTH — her one-line answer to our question is not a cue to write one line back: this reply carries the offer (rule 5). Keep her greeting style, warmth and emoji level; a sign-off with " + agentName.split(" ")[0] + "'s name only if she signed hers."
      : "7. MIRROR THE CLIENT'S LAYOUT — shape the reply the way the client shaped their latest message (rule 3 has the measured facts). Greeting line only if they used one; several short paragraphs in their order if they wrote that way; a closing line and " + agentName.split(" ")[0] + "'s first name on its own line ONLY if they closed with a sign-off and their name. A one-line text gets a one-line text back. Mirror the shape, not the length of every paragraph.",
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
    "- Return ONLY the message text to send. No preamble, no quotes, no notes. A signature (first name on the last line) ONLY when the client signed theirs (rule 3) — never because past replies had one.",
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
  revise?: boolean;
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
    opts.thread ? Promise.resolve(opts.thread) : getThread(opts.acct, opts.conversationId, { labelMedia: true }),
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

  // 🔁 Win-back people (any entry point — draft button, AI chat, Agent
  // cards): who she is, the ONE approved offer, and where the flow stands.
  const wbRow = opts.contactId ? await getWinbackForContact(opts.contactId).catch(() => null) : null;
  const winback = wbRow ? winbackContext(wbRow, thread) : undefined;
  const instructions = wbRow ? [winbackInstructions(wbRow), opts.instructions?.trim()].filter(Boolean).join("\n\n") : opts.instructions;

  const { draft, model } = await generateDraft({
    thread,
    contactName: opts.contactName,
    agentName,
    voiceSamples,
    instructions,
    winback,
    standingNotes: notesRow.data?.content ?? "",
    nameByUserId,
    inviteCall: !!opts.inviteCall,
    clientMemory: known?.facts ? withoutSecrets(known.facts) : undefined, // rows saved before the filter too
    revise: !!opts.revise,
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
