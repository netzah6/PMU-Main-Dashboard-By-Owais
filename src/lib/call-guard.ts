import { firstUnansweredIndex, type ThreadMessage } from "@/lib/ghl-conversations";

/* Strategy-call invites only when a PERSON asks for one (owner, 2026-10-01:
   "inviting people for a strategy call just from the AI's decision, without
   asking for my request"). Every reply the dashboard drafts — AI tab, Reply
   page, AI chat, Agent cards and their fallback — goes through this check.

   Two kinds of slip:
   - a booking / call LINK — never without the switch, even if the client
     asked for a call;
   - an INVITE aimed at the client ("hop on a quick call?", "book a call
     with me") — fine as an acknowledgement when the client really asked to
     talk ("Sure, happy to hop on a call tomorrow"), never otherwise.
   Booking-calendar talk is the agency's product ("clients can pick a time on
   your calendar", "book her into the 2pm slot") and must NOT trip it (the
   case table is in PR #750). */

const LINK_RE = /(pmu-bookings\.com|calendly\.com|cal\.com\/|\b[\w.-]+\.[a-z]{2,}\/[\w-]*-call\b)/i;
const INVITE_RE = new RegExp([
  // a call / zoom / meeting noun right after the verb: "book a quick call"
  String.raw`\b(book|schedule|set\s*up|grab)\s+(a\s+|an\s+)?(quick\s+|short\s+|free\s+)?(\d+\s*-?\s*min(ute)?s?\s+)?(strategy\s+)?(call|zoom|meeting)\b`,
  // time with ME / on MY calendar — aimed at the rep, not the artist's calendar
  String.raw`\b(book|schedule|grab|find|pick)\s+(a\s+)?time\s+(with\s+(me|us)|on\s+my)\b`,
  String.raw`\b(book|grab|pick|find)\b[^.!?\n]{0,25}\bmy\s+calendar\b`,
  // a second-person / let's ask to get on a call
  String.raw`\b(want\s+to|wanna|can\s+we|could\s+we|let'?s|open\s+to|like\s+to|happy\s+to|feel\s+free\s+to)\s+(\w+\s+){0,2}(hop|jump|get|hopping|jumping|getting)\s+on\s+(a|the)\s+(quick\s+|short\s+)?(call|phone|zoom)\b`,
  String.raw`\b(when'?s|what'?s)\s+(a\s+)?(good|best)\s+time\s+(to|for)\s+(chat|talk|a\s+call)\b`,
  String.raw`\bconnect\s+on\s+a\s+call\b`,
  String.raw`\b(call|zoom|meeting)\s+with\s+(me|us)\b`,
  String.raw`\b(quick|short)\s+\d+\s*-?\s*min(ute)?s?\s+(call|chat|zoom)\b`,
  String.raw`\b(let'?s|we\s+can|we\s+could)\s+do\s+a\s+(quick\s+)?(zoom|call)\b`,
  String.raw`\bstrategy\s+(call|session|meeting)\b`,
  String.raw`\b(agendemos|agendar|hagamos|tengamos)\s+una\s+(llamada|videollamada|reuni[oó]n)\b`,
].join("|"), "i");
// A real request to talk — not "my phone number changed" or "the AI didn't call them".
const CALL_ASK_RE = new RegExp([
  String.raw`\b(can|could|should|shall)\s+(we|you|i)\s+(please\s+)?(hop\s+on|jump\s+on|get\s+on|have|do|set\s+up|schedule|book)\s+(a\s+)?(quick\s+)?(call|zoom|meeting|chat)\b`,
  // "call me" as a request, not "leads keep trying to call me"
  String.raw`(^|[.!?,]\s*|\b(please|pls|can\s+you|could\s+you|just)\s+)(call|ring)\s+me\b`, String.raw`\bgive\s+me\s+a\s+call\b`,
  String.raw`\blet'?s\s+(talk|chat|meet|hop\s+on|jump\s+on|have\s+a\s+call|do\s+a\s+call)\b`,
  String.raw`\b(can|could)\s+(we|i)\s+(talk|speak|meet|chat)\b`,
  String.raw`\b(want|like|need)\s+to\s+(talk|speak|meet)\s+(with\s+)?(you|nicolas)\b`,
  String.raw`\bstrategy\s+call\b`,
  String.raw`\b(ll[aá]mame|podemos\s+hablar|quiero\s+hablar|(tener|hacer|agendar)\s+una\s+llamada)\b`,
].join("|"), "i");

// Did the client's own unanswered texts ask to talk / have a call?
export function clientAskedForCall(thread: ThreadMessage[]): boolean {
  return thread.slice(firstUnansweredIndex(thread))
    .some((m) => m.direction === "inbound" && CALL_ASK_RE.test(m.body));
}

export function callViolation(text: string, clientAsked: boolean): "link" | "invite" | null {
  if (LINK_RE.test(text)) return "link";
  if (!clientAsked && INVITE_RE.test(text)) return "invite";
  return null;
}

const wordCount = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

/* Drop the sentences that invite or carry a call link ("you can
   reschedule here: 👉 link" means nothing without the link). null when
   nothing worth sending is left. */
export function stripCallInvites(text: string, clientAsked: boolean): string | null {
  const lines = text.split(/\n/).map((line) =>
    line.split(/(?<=[.!?])\s+(?=\S)/)
      .filter((s) => !callViolation(s, clientAsked))
      .join(" "),
  );
  const out = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return wordCount(out) >= 3 ? out : null;
}

// A guarded copy of any reply text (used for the Agent's triage fallback).
export function guardReply(text: string | null, thread: ThreadMessage[]): string | null {
  if (!text) return null;
  const asked = clientAskedForCall(thread);
  return callViolation(text, asked) ? stripCallInvites(text, asked) : text;
}

// True when a text carries a call invite or any link (switch-OFF rules) —
// such texts never become learned examples.
export const hasCallInvite = (text: string) =>
  callViolation(text, false) !== null || /(https?:\/\/|www\.|\b[\w-]+\.(com|co|io|ly|me|net|org|app|link|care)\/)/i.test(text);

/* The AI chat only turns the invite on when the person's own message asks
   for one ("…and invite her to a strategy call") — never from words the
   chat model wrote, and never for "don't invite her to a call". */
export function userAskedForCallInvite(message: string): boolean {
  const m = message.toLowerCase();
  // "don't invite her to a call" / "no strategy call" — but not "no emojis, and invite her…"
  if (/\b(don'?t|do\s+not|never|no\s+need\s+to|without)\s+(\w+\s+){0,3}(invit\w*|call|strategy)\b|\bno\s+(strategy\s+)?call\b/i.test(m)) return false;
  return /strategy[\s-]*call|inv[ií]t\p{L}*[^.!?\n]{0,40}\b(call|zoom|meeting|llamada)\b|\bcall link\b/iu.test(m);
}
