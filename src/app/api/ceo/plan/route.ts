import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { buildMonthPlan } from "@/lib/ceo-plan";

// This month's plan for the CEO tab (owner, 2026-10-04). Admins only.
//   GET                         → the plan, built from live data
//   POST { ym, key, done }      → tick / untick one to-do
export const maxDuration = 60;

async function admin() {
  const auth = await getAuth();
  return auth && auth.role === "admin" ? auth : null;
}

export async function GET() {
  if (!(await admin())) return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const plan = await buildMonthPlan();
  return NextResponse.json(plan, { headers: { "Cache-Control": "no-store" }, status: "error" in plan ? 500 : 200 });
}

export async function POST(req: NextRequest) {
  const auth = await admin();
  if (!auth) return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { ym?: string; key?: string; done?: boolean };
  const ym = String(body.ym ?? ""), key = String(body.key ?? "").slice(0, 300);
  if (!/^\d{4}-\d{2}$/.test(ym) || !key) return NextResponse.json({ error: "ym and key required" }, { status: 400 });
  const svc = createServiceClient();
  if (body.done === false) {
    const { error } = await svc.from("ceo_plan_done").delete().eq("ym", ym).eq("item_key", key);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, done: null });
  }
  const row = { ym, item_key: key, done_by: auth.email ?? auth.userId, done_at: new Date().toISOString() };
  const { error } = await svc.from("ceo_plan_done").upsert(row);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, done: { by: row.done_by, at: row.done_at } });
}
