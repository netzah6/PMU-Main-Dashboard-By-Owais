import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import {
  getReplyAccount,
  getRoster,
  getThread,
  getVoiceSamples,
} from "@/lib/ghl-conversations";
import { generateDraft } from "@/lib/reply-draft";

export const maxDuration = 60;

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "AI is not configured yet — add ANTHROPIC_API_KEY to the dashboard environment." },
      { status: 503 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    conversationId?: string;
    contactName?: string;
    instructions?: string;
  };
  if (!body.conversationId) {
    return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
  }

  const acct = await getReplyAccount();
  if (!acct) return NextResponse.json({ error: "Account not found" }, { status: 404 });

  const email = (user.email ?? "").toLowerCase();
  const roster = await getRoster(acct);
  const meUser = roster.find((u) => u.email && u.email === email) ?? null;
  const agentName = meUser?.name || (email ? email.split("@")[0] : "our team");

  const svc = createServiceClient();
  const [thread, voiceSamples, notesRow] = await Promise.all([
    getThread(acct, body.conversationId),
    meUser ? getVoiceSamples(acct, meUser.id) : Promise.resolve<string[]>([]),
    svc.from("reply_ai_notes").select("content").eq("id", 1).single(),
  ]);
  const standingNotes = notesRow.data?.content ?? "";

  try {
    const { draft, model } = await generateDraft({
      thread,
      contactName: body.contactName ?? "",
      agentName,
      voiceSamples,
      instructions: body.instructions,
      standingNotes,
    });
    return NextResponse.json({
      draft,
      voice: { name: agentName, matched: !!meUser, samplesUsed: voiceSamples.length },
      model,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to generate a draft";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
