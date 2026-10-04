import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getReplyAccount } from "@/lib/ghl-conversations";
import { draftReplyFor } from "@/lib/reply-draft";

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
    contactId?: string | null;
    instructions?: string;
    inviteCall?: boolean; // the "📞 Invite to a strategy call" switch
    source?: string;
    revise?: boolean; // an edit of an earlier draft — keep everything, length may grow
  };
  if (!body.conversationId) {
    return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
  }

  const acct = await getReplyAccount();
  if (!acct) return NextResponse.json({ error: "Account not found" }, { status: 404 });

  try {
    // Same engine as the AI chat and the Agent cards: dated last-2-days
    // context, the logged-in teammate's real voice (else Nicolas's).
    const { draft, model, voice } = await draftReplyFor({
      acct,
      conversationId: body.conversationId,
      contactName: body.contactName ?? "",
      contactId: body.contactId ?? null,
      voiceEmail: user.email ?? null,
      instructions: body.instructions,
      inviteCall: body.inviteCall === true,
      revise: body.revise === true,
      source: body.source === "agent" ? "agent" : "draft",
    });
    return NextResponse.json({ draft, voice, model });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to generate a draft";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
