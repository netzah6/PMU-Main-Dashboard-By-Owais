import Anthropic from "@anthropic-ai/sdk";
import { BLAST_TAGS, autoFixTemplate, templateProblem } from "@/lib/blast-template";

/* ✨ AI twist for the blast message (owner, 11/12/2026): "sometimes we want
   to give it a little twist for maybe Christmas or Black Friday… keep the
   concept of that message: short, direct, to the point, and sweet. Because
   it's proven to work, I don't want to change it a lot."

   The AI only WRITES options into the Message box. A person still picks one,
   reads the preview and presses Send — nothing here texts anyone. Every
   option is checked by the same rules the blast itself enforces (tags typed
   exactly), stays close to the message's length, and keeps its shape:
   greeting → who it is → a few spots → one question. */

const MODEL = process.env.BLAST_TWIST_MODEL || "claude-sonnet-5-5";
export const TWIST_MAX_OCCASION = 80;
/** A twist may be a little longer than the message it starts from — not a new message. */
const EXTRA_CHARS = 70;

export const twistReady = () => !!process.env.ANTHROPIC_API_KEY;

const SYSTEM = `You adjust ONE short text message that a permanent-makeup artist sends to her past leads. The message is proven to work, so you change as little as possible: you only add a light touch for the occasion you are given.

Rules — every option must follow all of them:
- Keep the same shape and order: the greeting with the contact's first name, "It's <artist>", the line that a few spots opened up for the service, then ONE closing question asking if she would like to book one.
- Keep it short, direct and sweet. About the same length as the original (a few words more at most). Two short paragraphs, like the original.
- Change only a few words to bring in the occasion (for example "3 Black Friday spots", "before Christmas", "this week" → the occasion's timing). Do not rewrite the message.
- Copy these tags EXACTLY as written, each one exactly once: {{contact.first_name}} {{user.first_name}} {{service}}. Never invent other tags, never put real names in.
- Do NOT invent anything that is not in the original or the occasion: no prices, no discounts, no "% off", no gifts, no deadlines or dates, unless the occasion text itself gives them.
- No links, no hashtags, no ALL CAPS words, no "STOP to opt out" line. At most one emoji, and only if it fits the occasion.
- Plain, warm, everyday English, as one woman texting another.

Reply with JSON only: {"options": ["…", "…", "…"]} — three options that differ a little from each other, the first one closest to the original.`;

/** Plain-English reason an option can't be used, or null when it is fine. */
export function twistProblem(option: string, original: string): string | null {
  const o = option.trim();
  if (!o) return "empty";
  if (templateProblem(o)) return "broken tag";
  for (const t of BLAST_TAGS) {
    const had = original.split(t).length - 1;
    const has = o.split(t).length - 1;
    if (had > 0 && has !== had) return `tag ${t} missing or repeated`;
    if (had === 0 && has > 0) return `tag ${t} added`;
  }
  if (o.length > original.trim().length + EXTRA_CHARS) return "too long";
  if (/https?:\/\/|www\.|#\w/i.test(o)) return "link or hashtag";
  if (!/\?\s*(\p{Extended_Pictographic}|️|\s)*$/u.test(o)) return "does not end with the question";
  return null;
}

/** Up to three occasion twists of `template`. Throws a plain-English Error when it can't. */
export async function twistTemplate(template: string, occasion: string): Promise<string[]> {
  if (!twistReady()) throw new Error("The AI isn't connected on this site yet");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 40_000 });
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 1200,
    system: SYSTEM,
    messages: [{ role: "user", content: `ORIGINAL MESSAGE:\n${template.trim()}\n\nOCCASION: ${occasion.trim()}\n\nJSON only.` }],
  });
  if (res.stop_reason === "refusal") throw new Error("The AI couldn't write that one — try other words");
  const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const m = text.match(/\{[\s\S]*\}/);
  let raw: unknown[] = [];
  try { raw = (JSON.parse(m?.[0] ?? "{}") as { options?: unknown[] }).options ?? []; } catch { raw = []; }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    const o = autoFixTemplate(String(r ?? "")).trim();
    if (twistProblem(o, template) || o === template.trim() || seen.has(o)) continue;
    seen.add(o);
    out.push(o);
  }
  if (!out.length) throw new Error("The AI didn't give a usable message — please try again");
  return out.slice(0, 3);
}
