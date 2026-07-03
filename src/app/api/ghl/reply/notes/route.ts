import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";

// Standing notes the AI considers on every generated reply (single shared row).

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const svc = createServiceClient();
  const { data, error } = await svc.from("reply_ai_notes").select("content, updated_at, updated_by").eq("id", 1).single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ content: data?.content ?? "", updatedAt: data?.updated_at ?? null, updatedBy: data?.updated_by ?? null });
}

export async function PUT(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { content?: string };
  const content = String(body.content ?? "").slice(0, 4000); // keep the prompt lean

  const svc = createServiceClient();
  const { error } = await svc
    .from("reply_ai_notes")
    .upsert({ id: 1, content, updated_at: new Date().toISOString(), updated_by: user.email ?? null });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
