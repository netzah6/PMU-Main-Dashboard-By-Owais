import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { resolveClientLocation } from "@/lib/agent-exec";

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
  const q = String(body.client ?? "").trim().toLowerCase();
  const task = String(body.task ?? "").replace(/\s+\n/g, "\n").trim().slice(0, 1500);
  if (q.length < 3 || task.length < 8) return NextResponse.json({ error: "Name the client and describe the task" }, { status: 400 });

  // Clients Master: exact owner/business name first, then "contains".
  const { data: cm } = await svc.from("clients_master").select("data");
  const rows = (cm ?? []).map((r) => r.data as Record<string, unknown>);
  const owner = (d: Record<string, unknown>) => String(d["Owner Full Name"] ?? "").trim();
  const biz = (d: Record<string, unknown>) => String(d["Business Name"] ?? "").trim();
  const exact = rows.filter((d) => owner(d).toLowerCase() === q || biz(d).toLowerCase() === q);
  const loose = exact.length ? exact : rows.filter((d) => owner(d).toLowerCase().includes(q) || biz(d).toLowerCase().includes(q));
  const names = [...new Set(loose.map(owner).filter(Boolean))];
  if (!names.length) return NextResponse.json({ error: `No client matches "${body.client}"` }, { status: 404 });
  if (names.length > 1) return NextResponse.json({ error: `Several clients match: ${names.slice(0, 5).join(", ")} — type the full name` }, { status: 409 });
  const row = loose.find((d) => owner(d) === names[0])!;
  const contactId = String(row["Contact ID"] ?? "").trim() || null;
  const loc = await resolveClientLocation(svc, contactId, names[0]).catch(() => null);
  if (!loc) return NextResponse.json({ error: `Found ${names[0]}, but not their GoHighLevel sub-account` }, { status: 404 });

  const id = randomUUID();
  const by = user.email ?? user.id;
  const { data, error } = await svc.from("agent_proposals").insert({
    conversation_id: `task:${id}`,
    message_id: id,
    contact_id: contactId,
    contact_name: names[0],
    channel: null,
    client_message: `Task from ${by}:\n${task}`,
    summary: task.split("\n")[0].slice(0, 140),
    action_type: "account_change",
    proposed_reply: null,
    action_detail: task,
    action_plan: [{ type: "manual", what: task }],
    location_id: loc.locationId,
  }).select("id").maybeSingle();
  if (error || !data) return NextResponse.json({ error: error?.message ?? "could not save" }, { status: 500 });
  return NextResponse.json({ success: true, id: (data as { id: string }).id, client: `${names[0]}${loc.businessName ? ` (${loc.businessName})` : ""}` });
}
