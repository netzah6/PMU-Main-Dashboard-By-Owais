import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveClientLocation } from "@/lib/agent-exec";

type Svc = SupabaseClient;

export type TaskClient = { name: string; contactId: string | null; locationId: string; businessName: string | null };

// Clients Master: exact owner/business name first, then "contains".
export async function findTaskClient(svc: Svc, query: string): Promise<{ client?: TaskClient; error?: string; status?: number }> {
  const q = query.trim().toLowerCase();
  if (q.length < 3) return { error: "Name the client", status: 400 };
  const { data: cm } = await svc.from("clients_master").select("data");
  const rows = (cm ?? []).map((r) => r.data as Record<string, unknown>);
  const owner = (d: Record<string, unknown>) => String(d["Owner Full Name"] ?? "").trim();
  const biz = (d: Record<string, unknown>) => String(d["Business Name"] ?? "").trim();
  const exact = rows.filter((d) => owner(d).toLowerCase() === q || biz(d).toLowerCase() === q);
  const loose = exact.length ? exact : rows.filter((d) => owner(d).toLowerCase().includes(q) || biz(d).toLowerCase().includes(q));
  const names = [...new Set(loose.map(owner).filter(Boolean))];
  if (!names.length) return { error: `No client matches "${query}"`, status: 404 };
  if (names.length > 1) return { error: `Several clients match: ${names.slice(0, 5).join(", ")} — type the full name`, status: 409 };
  const row = loose.find((d) => owner(d) === names[0])!;
  const contactId = String(row["Contact ID"] ?? "").trim() || null;
  const loc = await resolveClientLocation(svc, contactId, names[0]).catch(() => null);
  if (!loc) return { error: `Found ${names[0]}, but not their GoHighLevel sub-account`, status: 404 };
  return { client: { name: names[0], contactId, locationId: loc.locationId, businessName: loc.businessName ?? null } };
}

/** Every owner + business name, for a model picking the client out of a conversation. */
export async function clientNameList(svc: Svc): Promise<string[]> {
  const { data: cm } = await svc.from("clients_master").select("data");
  const out = new Set<string>();
  for (const r of cm ?? []) {
    const d = r.data as Record<string, unknown>;
    const o = String(d["Owner Full Name"] ?? "").trim();
    const b = String(d["Business Name"] ?? "").trim();
    if (o) out.add(b ? `${o} (${b})` : o);
  }
  return [...out].sort();
}

// A typed task becomes a pending card — Approve still decides — and the
// Mac Mini does it in GoHighLevel.
export async function createTaskCard(svc: Svc, input: {
  client: TaskClient; task: string; from: string; context?: string; summary?: string;
}): Promise<{ id?: string; error?: string }> {
  const id = randomUUID();
  const task = input.task.trim();
  const { data, error } = await svc.from("agent_proposals").insert({
    conversation_id: `task:${id}`,
    message_id: id,
    contact_id: input.client.contactId,
    contact_name: input.client.name,
    channel: null,
    client_message: `Task from ${input.from}:\n${input.context?.trim() || task}`,
    summary: (input.summary || task.split("\n")[0]).slice(0, 140),
    action_type: "account_change",
    proposed_reply: null,
    action_detail: task,
    action_plan: [{ type: "manual", what: task }],
    location_id: input.client.locationId,
  }).select("id").maybeSingle();
  if (error || !data) return { error: error?.message ?? "could not save" };
  return { id: (data as { id: string }).id };
}
