import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getAuth } from "@/lib/ppa";
import { parseAgreement, agreementToText, type Agreement } from "@/lib/agreement";

export const maxDuration = 120;

// "Add this to the agreement" / "change that" in plain English, applied to the
// document by Claude. The model returns the WHOLE revised agreement as JSON,
// which is validated before anything is shown — a malformed answer is an
// error, never a half-broken document. The model is told to change only what
// was asked and leave every other word exactly as it is.

const MODEL = "claude-sonnet-4-5";

const SYSTEM = `You edit a legal-style partner agreement for PMU Bookings On Demand, a marketing
agency serving permanent-makeup artists. The owner tells you in plain English
what to add, remove or change. You apply exactly that and nothing else.

Rules:
- Change ONLY what the instruction asks. Every other block must be returned
  word-for-word as it was — do not fix typos, reflow sentences, renumber, or
  "improve" anything you were not asked to touch.
- Match the existing tone: plain, direct, second-person to "the partner".
- A new clause goes where it logically belongs (e.g. a payment term under
  pricing). If unsure, add it as a new heading + paragraph before the
  signature block.
- Keep the signature block last. Keep the title unless told to change it.
- Return ONLY a JSON object, no prose, no code fences:
  {"agreement": <the full agreement JSON in the same schema>, "summary": "<one sentence saying what you changed>"}

Schema for "agreement":
{"title": string, "footer": string, "blocks": [
  {"type":"heading","text":string} | {"type":"paragraph","text":string} |
  {"type":"bullets","items":string[]} | {"type":"numbered","items":string[]} |
  {"type":"signature"}
]}`;

export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth || auth.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: "AI is not configured — ANTHROPIC_API_KEY is missing." }, { status: 503 });

  const body = (await req.json().catch(() => ({}))) as { agreement?: unknown; instruction?: string };
  const current = parseAgreement(body.agreement);
  const instruction = String(body.instruction ?? "").trim();
  if (!current) return NextResponse.json({ error: "Current agreement is malformed" }, { status: 400 });
  if (!instruction) return NextResponse.json({ error: "Say what to change" }, { status: 400 });

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM,
    messages: [{
      role: "user",
      content:
        `CURRENT AGREEMENT (JSON):\n${JSON.stringify(current)}\n\n` +
        `For reference, as text:\n${agreementToText(current)}\n\n` +
        `INSTRUCTION FROM THE OWNER:\n${instruction}`,
    }],
  });
  const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("").trim();
  // Tolerate a stray code fence; anything else must parse cleanly.
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: { agreement?: unknown; summary?: string };
  try { parsed = JSON.parse(cleaned); } catch {
    return NextResponse.json({ error: "The AI did not return a valid document — try wording the change differently." }, { status: 502 });
  }
  const revised: Agreement | null = parseAgreement(parsed.agreement);
  if (!revised) return NextResponse.json({ error: "The AI returned a malformed agreement — nothing was changed." }, { status: 502 });
  return NextResponse.json({ agreement: revised, summary: String(parsed.summary ?? "Updated.") });
}
