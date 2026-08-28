import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import type { AlertRow } from "@/lib/alerts";

// Alerts board — admin only (it's the CEO's notification center).
async function requireAdmin() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const svc = createServiceClient();
  const { data: role } = await svc.from("user_roles").select("role").eq("user_id", user.id).maybeSingle();
  if (role?.role !== "admin") return { error: NextResponse.json({ error: "Admins only" }, { status: 403 }) };
  return { user, svc };
}

export async function GET(req: NextRequest) {
  const gate = await requireAdmin();
  if ("error" in gate) return gate.error;
  const { svc } = gate;

  // ?count=1 → just the open count, for the nav badge.
  if (req.nextUrl.searchParams.get("count") === "1") {
    const { count } = await svc.from("alerts").select("id", { count: "exact", head: true }).eq("status", "open");
    return NextResponse.json({ open: count ?? 0 });
  }

  const { data: open } = await svc
    .from("alerts").select("*").eq("status", "open")
    .order("created_at", { ascending: false }).limit(200);
  const { data: resolved } = await svc
    .from("alerts").select("*").eq("status", "resolved")
    .order("resolved_at", { ascending: false }).limit(50);
  return NextResponse.json({ open: (open ?? []) as AlertRow[], resolved: (resolved ?? []) as AlertRow[] });
}

export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if ("error" in gate) return gate.error;
  const { user, svc } = gate;

  const body = (await req.json().catch(() => ({}))) as { id?: string; action?: string };
  const id = String(body.id ?? "");
  const action = String(body.action ?? "");
  if (!id || !["resolve", "reopen"].includes(action)) {
    return NextResponse.json({ error: "id and action (resolve|reopen) required" }, { status: 400 });
  }
  const patch = action === "resolve"
    ? { status: "resolved", resolved_by: user.email ?? user.id, resolved_at: new Date().toISOString() }
    : { status: "open", resolved_by: null, resolved_at: null };
  const { error } = await svc.from("alerts").update(patch).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
