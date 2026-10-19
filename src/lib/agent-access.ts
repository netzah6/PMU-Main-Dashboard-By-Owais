import type { SupabaseClient } from "@supabase/supabase-js";
import { getCoachScope } from "@/lib/coach";

/* Who may use the AI agent (owner, 10/19/2026: "my CSMs should be able to use
   'The AI has a plan — review' so the Mac Mini does tasks for them").
   Admins: everything. Coaches (role editor): their own clients only (Clients
   Master "Assigned" = coach), plus tasks they typed themselves; never a
   SENSITIVE card (refunds / charges / cancellations) and never a card that
   sends anything to a client (only account_change runs on the Mac Mini). */
export type AgentAccess = { userId: string; email: string; isAdmin: boolean; ownerKeys: Set<string> | null };
type Svc = SupabaseClient;
const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

export async function agentAccess(svc: Svc, user: { id: string; email?: string | null }): Promise<AgentAccess | null> {
  const { data: roleRow } = await svc.from("user_roles").select("role").eq("user_id", user.id).maybeSingle();
  const role = (roleRow as { role?: string } | null)?.role ?? null;
  if (role === "admin") return { userId: user.id, email: norm(user.email), isAdmin: true, ownerKeys: null };
  if (role !== "editor") return null;
  const scope = await getCoachScope(svc, { userId: user.id, email: user.email ?? null, role });
  return { userId: user.id, email: norm(user.email), isAdmin: false, ownerKeys: scope.ownerKeys ?? new Set<string>() };
}

type CardLike = { contact_name?: string | null; action_detail?: string | null; action_type?: string | null; client_message?: string | null };
export const isSensitive = (p: CardLike) => String(p.action_detail ?? "").startsWith("SENSITIVE:");
const isOwnTask = (a: AgentAccess, p: CardLike) => !!a.email && String(p.client_message ?? "").toLowerCase().startsWith(`task from ${a.email}`);
export const inScope = (a: AgentAccess, contactName: string | null | undefined) => a.isAdmin || (a.ownerKeys?.has(norm(contactName)) ?? false);
/** May this person see the card? */
export const canSee = (a: AgentAccess, p: CardLike) => a.isAdmin || (!isSensitive(p) && (inScope(a, p.contact_name) || isOwnTask(a, p)));
/** May this person approve / deny / retry it? Coaches: Mac Mini account changes only. */
export const canAct = (a: AgentAccess, p: CardLike) => a.isAdmin || (canSee(a, p) && p.action_type === "account_change");
