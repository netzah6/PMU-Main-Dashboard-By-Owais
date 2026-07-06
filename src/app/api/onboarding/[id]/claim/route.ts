import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { claimPoolAccount, unclaimPoolAccount, discoverPool, type ClaimResult } from "@/lib/ghl-claim";

export const maxDuration = 60;

// Claim a "Clean New Account" pool sub-account for this onboarding:
// rename it to the client's business and fill custom values from the form.
// GET  → list available pool accounts (to pick one in the UI)
// POST → run the claim ({ poolLocationId } — defaults to the first available)
// DELETE → un-claim (rename the account back to its pool name; testing)

async function authed(req: NextRequest): Promise<string | null> {
  const authHeader = req.headers.get("authorization");
  if (!!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`) return "automation";
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user?.email ?? null;
}

export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ pool: await discoverPool() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "pool discovery failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const who = await authed(req);
  if (!who) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const svc = createServiceClient();
  const { data: row, error: fetchErr } = await svc.from("onboardings").select("*").eq("id", params.id).single();
  if (fetchErr || !row) return NextResponse.json({ error: fetchErr?.message ?? "Not found" }, { status: 404 });
  if (row.claim) return NextResponse.json({ error: "Already claimed — un-claim first" }, { status: 409 });

  const body = (await req.json().catch(() => ({}))) as { poolLocationId?: string };
  try {
    let poolId = String(body.poolLocationId ?? "").trim();
    if (!poolId) {
      const pool = await discoverPool();
      if (!pool.length) return NextResponse.json({ error: "No unclaimed pool accounts available" }, { status: 409 });
      poolId = pool[0].id;
    }

    const result = await claimPoolAccount(poolId, row.form as Record<string, string>);
    const claim = { ...result, claimed_at: new Date().toISOString(), claimed_by: who };

    // Auto-check the checklist steps the claim just performed.
    const checklist = { ...(row.checklist as Record<string, unknown>) };
    const AUTO_STEPS: Record<string, string> = {
      "Fanbasis product ID": "funnel_product_id",
      "AREA": "wf_area",
      "Map address": "funnel_map",
    };
    for (const a of result.actions) {
      if (!a.ok) continue;
      const stepKey = Object.entries(AUTO_STEPS).find(([label]) => a.action.startsWith(label))?.[1];
      if (stepKey) checklist[stepKey] = { done: true, by: "automation", at: new Date().toISOString() };
    }

    const { data, error } = await svc.from("onboardings").update({ claim, checklist }).eq("id", params.id).select("*").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ onboarding: data, claim });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "claim failed" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  if (!(await authed(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const svc = createServiceClient();
  const { data: row, error: fetchErr } = await svc.from("onboardings").select("*").eq("id", params.id).single();
  if (fetchErr || !row) return NextResponse.json({ error: fetchErr?.message ?? "Not found" }, { status: 404 });
  if (!row.claim) return NextResponse.json({ error: "Nothing to un-claim" }, { status: 409 });

  try {
    await unclaimPoolAccount(row.claim as ClaimResult);
    const { data, error } = await svc.from("onboardings").update({ claim: null }).eq("id", params.id).select("*").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ onboarding: data });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "un-claim failed" }, { status: 500 });
  }
}
