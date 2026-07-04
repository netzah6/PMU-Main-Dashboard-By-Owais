import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";

// List onboardings (newest first).
export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const svc = createServiceClient();
  const { data, error } = await svc
    .from("onboardings")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ onboardings: data ?? [] });
}

// Create a new onboarding from the form.
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { form?: Record<string, string> };
  const form = body.form ?? {};
  if (!String(form.business_name ?? "").trim() || !String(form.owner_name ?? "").trim()) {
    return NextResponse.json({ error: "Business name and owner name are required" }, { status: 400 });
  }

  const svc = createServiceClient();
  const { data, error } = await svc
    .from("onboardings")
    .insert({ form, created_by: user.email ?? null })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ onboarding: data });
}
