import { createServiceClient } from "@/lib/supabase/server";

// Account credit for a PPS client — money we owe back, applied against their
// next service-fee charge. A coach requests, an admin approves (same two-step
// as deposit refunds), and the approved balance is drawn down as charges run.

export type CreditRow = {
  id: string;
  owner_key: string;
  client_label: string | null;
  amount: number;
  reason: string;
  status: "pending" | "approved" | "denied";
  applied: number;
  requested_by: string | null;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
};

type Svc = ReturnType<typeof createServiceClient>;

/** Unused approved credit per owner_key: approved amount minus what's applied. */
export async function creditBalances(svc: Svc, ownerKeys?: string[]): Promise<Map<string, number>> {
  let q = svc.from("client_credits").select("owner_key, amount, applied").eq("status", "approved");
  if (ownerKeys?.length) q = q.in("owner_key", ownerKeys);
  const { data } = await q;
  const out = new Map<string, number>();
  for (const r of (data ?? []) as Array<{ owner_key: string; amount: number; applied: number }>) {
    const left = Number(r.amount) - Number(r.applied);
    if (left > 0) out.set(r.owner_key, (out.get(r.owner_key) ?? 0) + left);
  }
  return out;
}

/**
 * Draw `used` dollars off a client's approved credits, oldest first. Called
 * right after a charge succeeds — the charge was already reduced by this much,
 * so the credit must not be spendable twice.
 */
export async function consumeCredit(svc: Svc, ownerKey: string, used: number): Promise<void> {
  if (!(used > 0)) return;
  const { data } = await svc
    .from("client_credits")
    .select("id, amount, applied")
    .eq("owner_key", ownerKey)
    .eq("status", "approved")
    .order("requested_at", { ascending: true });
  let left = used;
  for (const r of (data ?? []) as Array<{ id: string; amount: number; applied: number }>) {
    if (left <= 0) break;
    const available = Number(r.amount) - Number(r.applied);
    if (available <= 0) continue;
    const take = Math.min(available, left);
    left -= take;
    await svc
      .from("client_credits")
      .update({ applied: Number(r.applied) + take, updated_at: new Date().toISOString() })
      .eq("id", r.id);
  }
}
