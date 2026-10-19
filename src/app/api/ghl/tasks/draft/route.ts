import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { getReplyAccount, getThread } from "@/lib/ghl-conversations";

export const maxDuration = 60;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

/* "Create this as a task" in the AI tab (owner, 10/19/2026): the AI reads
   the whole chat, works out what the team actually has to do for this
   client, and proposes the task — title, details, due date. The team sees
   it in the form, edits if needed, then presses Create. Nothing is created
   here; this only drafts. */
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: roleRow } = await supabase.from("user_roles").select("role").eq("user_id", user.id).maybeSingle();
  if (!(roleRow as { role?: string } | null)?.role) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const b = (await req.json().catch(() => ({}))) as { conversationId?: string; contactName?: string; note?: string };
  if (!b.conversationId) return NextResponse.json({ error: "conversationId required" }, { status: 400 });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "AI drafting is not set up (ANTHROPIC_API_KEY)" }, { status: 500 });
  const acct = await getReplyAccount();
  if (!acct) return NextResponse.json({ error: "main account token unavailable" }, { status: 500 });

  const thread = await getThread(acct, b.conversationId, { limit: 60 });
  const name = String(b.contactName ?? "the client").trim();
  const transcript = thread.slice(-40).map((m) => {
    const when = m.dateAdded ? new Date(m.dateAdded).toLocaleString("en-US", { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
    return `[${when}] ${m.direction === "inbound" ? name : "Us (team)"}: ${m.body.replace(/\s+/g, " ").trim().slice(0, 600)}`;
  }).join("\n");
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 500,
    system: `You turn a client conversation into ONE internal task for the PMU Bookings On Demand team (a marketing agency for permanent-makeup artists; the client is an artist we work for). Read the chat, figure out what the TEAM still has to do for this client, and write the task.

Rules:
- "title": short, starts with the client's first name, says the action (e.g. "Sonia: set her calendar hours to Sun/Mon/Fri"). Max 80 characters.
- "details": 2–5 plain lines a teammate can act on without reading the chat: what to do, where (GoHighLevel, ads, calendar, billing…), every specific the client gave (dates, times, prices, names, numbers), and what to tell the client afterwards. No fluff.
- "dueInDays": 1 for anything urgent or promised, 2–3 for normal, up to 7 if the client set a later date. Integer.
- If the chat has no open action for the team (just thanks / already handled), still write the most useful follow-up task and say in details that nothing is pending.
Answer with JSON only: {"title": "...", "details": "...", "dueInDays": 1}`,
    messages: [{ role: "user", content: `Today is ${today}.\nClient: ${name}${b.note ? `\nTeammate's note: ${String(b.note).slice(0, 300)}` : ""}\n\nConversation (oldest first):\n${transcript || "(no messages loaded)"}` }],
  });
  const text = msg.content.filter((x): x is Anthropic.TextBlock => x.type === "text").map((x) => x.text).join("").trim();
  const m = text.match(/\{[\s\S]*\}/);
  let out: { title?: string; details?: string; dueInDays?: number } = {};
  try { out = m ? JSON.parse(m[0]) : {}; } catch { /* fall through */ }
  if (!out.title) return NextResponse.json({ error: "The AI could not write a task from this chat — fill it in by hand" }, { status: 502 });
  return NextResponse.json({
    title: String(out.title).slice(0, 120),
    details: String(out.details ?? "").slice(0, 1500),
    dueInDays: Math.min(14, Math.max(1, Math.round(Number(out.dueInDays) || 2))),
    model: MODEL,
  });
}
