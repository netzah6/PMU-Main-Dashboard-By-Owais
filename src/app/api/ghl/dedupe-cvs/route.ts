import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { dedupeCustomValues } from "@/lib/ghl-claim";

export const maxDuration = 60;

// Duplicate "CC -" custom values on ANY sub-account (the onboarding claim
// route can only reach accounts set up by the setup tool). Brows by Susan,
// 10/30/2026: the AI read the empty twin of "CC - Deposit Funnel URL (V3)"
// and told leads the reservation link was broken.
// POST { locationId, dryRun = true, only? } — dryRun returns the plan only;
// pass `only` (one name) per call on big accounts so a run fits in 60 s.
// Auth: CRON_SECRET or a logged-in admin.
async function authorized(req: NextRequest): Promise<boolean> {
  const h = req.headers.get("authorization");
  if (process.env.CRON_SECRET && h === `Bearer ${process.env.CRON_SECRET}`) return true;
  const { data: { user } } = await createClient().auth.getUser();
  if (!user) return false;
  const { data } = await createServiceClient().from("user_roles").select("role").eq("user_id", user.id).maybeSingle();
  return (data as { role?: string } | null)?.role === "admin";
}

export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { locationId?: string; dryRun?: boolean; only?: string };
  const locationId = String(body.locationId ?? "").trim();
  if (!/^[A-Za-z0-9]{10,40}$/.test(locationId)) return NextResponse.json({ error: "locationId required" }, { status: 400 });
  try {
    return NextResponse.json({ dedupe: await dedupeCustomValues(locationId, body.dryRun !== false, body.only) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "dedupe failed" }, { status: 500 });
  }
}
