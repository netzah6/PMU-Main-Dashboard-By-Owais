import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { proposeForConversation } from "@/lib/agent";

export const maxDuration = 60; // reads the chat, triages it and drafts the reply

// "Let AI handle it" on one conversation — admin only. Files (or returns the
// already-open) pending card with the plan and the drafted reply. Nothing is
// sent or changed here: the card's Approve (/api/agent/decide) does that.
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const svc = createServiceClient();
  const { data: roleRow } = await svc.from("user_roles").select("role").eq("user_id", user.id).maybeSingle();
  if ((roleRow as { role?: string } | null)?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden — admin only" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    conversationId?: string; contactId?: string | null; contactName?: string; channel?: string | null;
    fresh?: boolean; // "re-read chat": plan again even with no new message
  };
  const conversationId = String(body.conversationId ?? "").trim();
  if (!conversationId) return NextResponse.json({ error: "conversationId required" }, { status: 400 });

  try {
    const r = await proposeForConversation({
      conversationId,
      contactId: body.contactId ?? null,
      contactName: String(body.contactName ?? "").trim() || "Client",
      channel: body.channel ?? null,
      requestedBy: user.email ?? "",
      fresh: body.fresh === true,
    });
    if (r.error || !r.proposal) return NextResponse.json({ error: r.error ?? "failed" }, { status: 502 });
    return NextResponse.json({ proposal: r.proposal });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
