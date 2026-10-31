import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { createTaskCard, findTaskClient } from "@/lib/agent-task";

// A teammate types a task for a client ("add a stage before Declining in
// Tammy's pipeline"). It becomes a pending card — Approve still decides —
// and the Mac Mini does it in GoHighLevel. Any team member may add one.
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const svc = createServiceClient();
  const { data: roleRow } = await svc.from("user_roles").select("role").eq("user_id", user.id).maybeSingle();
  if (!(roleRow as { role?: string } | null)?.role) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { client?: string; task?: string };
  const task = String(body.task ?? "").replace(/\s+\n/g, "\n").trim().slice(0, 1500);
  if (String(body.client ?? "").trim().length < 3 || task.length < 8) return NextResponse.json({ error: "Name the client and describe the task" }, { status: 400 });

  const found = await findTaskClient(svc, String(body.client));
  if (!found.client) return NextResponse.json({ error: found.error }, { status: found.status ?? 404 });
  const made = await createTaskCard(svc, { client: found.client, task, from: user.email ?? user.id });
  if (!made.id) return NextResponse.json({ error: made.error }, { status: 500 });
  const c = found.client;
  return NextResponse.json({ success: true, id: made.id, client: `${c.name}${c.businessName ? ` (${c.businessName})` : ""}` });
}
