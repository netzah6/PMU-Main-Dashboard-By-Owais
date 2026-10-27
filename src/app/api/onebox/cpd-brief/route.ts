import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { computeBriefs } from "@/lib/cpd-brief";

export const fetchCache = "force-no-store";
export const maxDuration = 120;

// The client brief shown at the top of a Cost per Deposit dropdown.
// GET  ?ownerKey=  → the stored brief (null when none yet)
// POST {ownerKey}  → recompute it now and return it
async function slugFor(svc: ReturnType<typeof createServiceClient>, ownerKey: string): Promise<string | null> {
  const { data } = await svc.from("onebox_active_clients").select("owner_name, slug");
  const hit = (data ?? []).find((r) => String(r.owner_name ?? "").toLowerCase().trim() === ownerKey);
  return hit ? String(hit.slug) : null;
}

async function readBrief(svc: ReturnType<typeof createServiceClient>, slug: string) {
  const { data } = await svc.from("cpd_briefs").select("slug, owner_key, status, headline, situation, actions, watch, issues, model, computed_at").eq("slug", slug).maybeSingle();
  return data ?? null;
}

export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ownerKey = req.nextUrl.searchParams.get("ownerKey")?.toLowerCase().trim();
  if (!ownerKey) return NextResponse.json({ error: "ownerKey required" }, { status: 400 });
  const svc = createServiceClient();
  const slug = await slugFor(svc, ownerKey);
  if (!slug) return NextResponse.json({ brief: null, slug: null });
  return NextResponse.json({ brief: await readBrief(svc, slug), slug });
}

export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { ownerKey?: string };
  const ownerKey = String(body.ownerKey ?? "").toLowerCase().trim();
  if (!ownerKey) return NextResponse.json({ error: "ownerKey required" }, { status: 400 });
  const svc = createServiceClient();
  const slug = await slugFor(svc, ownerKey);
  if (!slug) return NextResponse.json({ error: "This client has no one-box funnel" }, { status: 404 });
  const r = await computeBriefs(svc, { slug, deadlineMs: 100_000 });
  if (!r.computed) return NextResponse.json({ error: "Not a live client with a one-box" }, { status: 404 });
  return NextResponse.json({ brief: await readBrief(svc, slug), slug, modelFailed: r.modelFailed });
}
