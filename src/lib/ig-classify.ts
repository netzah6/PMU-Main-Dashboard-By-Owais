import Anthropic from "@anthropic-ai/sdk";
import type { PostKind } from "@/lib/ig-arrange";

/* Looks at each Instagram picture (not its caption) and says what it
   shows, so the funnel grid can lead with finished work. One short call
   per picture; a picture is classified once and the verdict travels with
   the post URL on later fetches (ig-fetch.ts), so a fortnightly refresh
   only pays for the posts that are new. Without ANTHROPIC_API_KEY the feed
   falls back to the caption order. */

export type PostClass = { kind: PostKind; pmu: boolean; q: number };

const MODEL = process.env.IG_CLASSIFY_MODEL || "claude-opus-5-5";
const CONCURRENCY = 3;
const KINDS: PostKind[] = ["split_ba", "after_closeup", "during", "person", "flyer_text", "other"];

const SYSTEM = `You classify a single Instagram picture from a permanent-makeup (PMU: eyebrows, lip blush, eyeliner) artist. A nervous first-time client sees it on a booking page. Answer with JSON only, no prose:
{"kind": "<split_ba|after_closeup|during|person|flyer_text|other>", "pmu": <true|false>, "q": <1-5>}
kind:
- split_ba: before AND after of the same client in one image (side by side, top/bottom, or a swipe split).
- after_closeup: finished work only — a close-up of brows, lips, eyeliner or a healed result on a client's face, no "before".
- during: the procedure in progress (gloves, tools, mapping lines, numbing cream, pigment on skin).
- person: a person or people where the work is not the subject — selfie, portrait, team photo, talking-to-camera cover, smiling full face without a clear result focus.
- flyer_text: promo graphic, announcement, text card, quote, price list, holiday sign, meme, training ad.
- other: anything else — piercings, tattoos, lashes, products, studio interior, scenery, food, pets, screenshots.
pmu: true when the picture shows PMU work (brows/lips/liner) in any way.
q: 1-5, how convincing the shot is for a prospective client (lighting, focus, crop, realistic skin): 5 magazine-grade, 1 blurry/dark/unflattering.
Be literal: a face with no visible brow/lip work focus is "person", not "after_closeup".`;

export function classifierReady(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

async function classifyOne(client: Anthropic, url: string, errors: string[]): Promise<PostClass | null> {
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      system: SYSTEM,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "url", url } },
          { type: "text", text: "Classify this picture. JSON only." },
        ],
      }],
    });
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) { errors.push(`${res.stop_reason}: ${text.slice(0, 120) || "(no text)"}`); return null; }
    const j = JSON.parse(m[0]) as { kind?: unknown; pmu?: unknown; q?: unknown };
    const kind = KINDS.includes(j.kind as PostKind) ? (j.kind as PostKind) : null;
    if (!kind) { errors.push(`bad kind: ${m[0].slice(0, 120)}`); return null; }
    const q = Math.min(5, Math.max(1, Math.round(Number(j.q) || 3)));
    return { kind, pmu: !!j.pmu, q };
  } catch (e) {
    errors.push(e instanceof Error ? `${e.name}: ${e.message.slice(0, 160)}` : String(e).slice(0, 160));
    return null;
  }
}

/* Classify a batch of picture URLs (public copies in our bucket). Pictures
   that fail are simply left out — the caller keeps them unsorted. */
export async function classifyImages(urls: string[], errors: string[] = []): Promise<Map<string, PostClass>> {
  const out = new Map<string, PostClass>();
  if (!classifierReady() || !urls.length) return out;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 3, timeout: 60_000 });
  const queue = [...new Set(urls)];
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let u = queue.shift(); u; u = queue.shift()) {
      const c = await classifyOne(client, u, errors);
      if (c) out.set(u, c);
    }
  }));
  return out;
}
