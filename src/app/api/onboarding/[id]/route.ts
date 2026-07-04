import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";

// Update one onboarding: toggle a checklist step, edit the form, or set status.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    stepKey?: string;
    done?: boolean;
    form?: Record<string, string>;
    status?: string;
  };

  const svc = createServiceClient();
  const { data: row, error: fetchErr } = await svc.from("onboardings").select("*").eq("id", params.id).single();
  if (fetchErr || !row) return NextResponse.json({ error: fetchErr?.message ?? "Not found" }, { status: 404 });

  const update: Record<string, unknown> = {};
  if (body.stepKey) {
    const checklist = { ...(row.checklist as Record<string, unknown>) };
    if (body.done) {
      checklist[body.stepKey] = { done: true, by: user.email ?? "?", at: new Date().toISOString() };
    } else {
      delete checklist[body.stepKey];
    }
    update.checklist = checklist;
  }
  if (body.form) update.form = { ...(row.form as Record<string, unknown>), ...body.form };
  if (body.status) update.status = body.status;

  const { data, error } = await svc.from("onboardings").update(update).eq("id", params.id).select("*").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ onboarding: data });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const svc = createServiceClient();
  const { error } = await svc.from("onboardings").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
