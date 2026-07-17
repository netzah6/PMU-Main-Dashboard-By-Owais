import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { verifyOnboarding } from "@/lib/onboarding-verify";

export const maxDuration = 120;

// Ad-hoc setup check by client/business name — no onboarding record needed.
// Resolves the sub-account from the name, then grades the live setup.
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { business?: string };
  const business = String(body.business ?? "").trim();
  if (!business) return NextResponse.json({ error: "business name required" }, { status: 400 });

  const result = await verifyOnboarding({ business_name: business });
  return NextResponse.json({ ranAt: new Date().toISOString(), business, ...result });
}
