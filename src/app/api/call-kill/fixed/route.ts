import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";

// CPD tab "Kill %" — which clients' outgoing-call workflow has been fixed so
// calling a lead no longer stops the AI (owner, 2026-10-03). Admin only, like
// the CPD tab itself.
//   GET           → { fixes: { [owner_key]: { fixed_by, fixed_at } } }
//   POST { ownerKey, fixed } → mark / unmark

async function admin() {
  const auth = await getAuth();
  return auth && auth.role === "admin" ? auth : null;
}

export async function GET() {
  if (!(await admin())) return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const { data, error } = await createServiceClient().from("call_kill_fixes").select("owner_key, fixed_by, fixed_at").eq("fixed", true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const fixes: Record<string, { fixed_by: string | null; fixed_at: string }> = {};
  for (const r of (data ?? []) as Array<{ owner_key: string; fixed_by: string | null; fixed_at: string }>) fixes[r.owner_key] = { fixed_by: r.fixed_by, fixed_at: r.fixed_at };
  return NextResponse.json({ fixes });
}

export async function POST(req: NextRequest) {
  const auth = await admin();
  if (!auth) return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { ownerKey?: string; fixed?: boolean };
  const ownerKey = String(body.ownerKey ?? "").trim().toLowerCase();
  if (!ownerKey) return NextResponse.json({ error: "ownerKey required" }, { status: 400 });
  const svc = createServiceClient();
  if (body.fixed === false) {
    const { error } = await svc.from("call_kill_fixes").delete().eq("owner_key", ownerKey);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, fixed: false });
  }
  const row = { owner_key: ownerKey, fixed: true, fixed_by: auth.email ?? auth.userId, fixed_at: new Date().toISOString() };
  const { error } = await svc.from("call_kill_fixes").upsert(row);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, fixed: true, fixed_by: row.fixed_by, fixed_at: row.fixed_at });
}
