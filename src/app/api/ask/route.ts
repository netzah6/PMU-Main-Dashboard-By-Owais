import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { askAi, type AskMessage } from "@/lib/ask-ai";

export const maxDuration = 120;

// "Ask AI" chat — answers questions about clients/leads by querying the
// dashboard's own data (read-only) with Claude.
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "AI is not configured — ANTHROPIC_API_KEY is missing." },
      { status: 503 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as { messages?: AskMessage[] };
  const messages = (body.messages ?? []).filter(
    (m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim(),
  ).slice(-20);
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return NextResponse.json({ error: "Last message must be from the user" }, { status: 400 });
  }

  try {
    const { data: roleRow } = await supabase.from("user_roles").select("role").eq("user_id", user.id).maybeSingle();
    const isAdmin = (roleRow as { role?: string } | null)?.role === "admin";
    const result = await askAi(messages, user.email ?? "", isAdmin);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "AI request failed" }, { status: 500 });
  }
}
