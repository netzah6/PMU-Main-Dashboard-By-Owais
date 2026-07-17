import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { verifyOnboarding } from "@/lib/onboarding-verify";

export const maxDuration = 120;

// Auto-verify one onboarding's technical setup (funnel pages, Fanbasis product,
// GHL custom values, sheets). Returns a pass/fail/manual status per checklist
// step so the user doesn't have to eyeball each setup by hand.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const svc = createServiceClient();
  const { data: ob, error } = await svc.from("onboardings").select("form, claim").eq("id", id).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!ob) return NextResponse.json({ error: "Onboarding not found" }, { status: 404 });

  const locationId = (ob.claim as { location_id?: string } | null)?.location_id ?? null;
  const result = await verifyOnboarding((ob.form ?? {}) as Record<string, unknown>, { locationId });
  return NextResponse.json({ ranAt: new Date().toISOString(), ...result });
}
