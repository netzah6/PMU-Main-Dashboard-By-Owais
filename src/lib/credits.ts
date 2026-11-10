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
 *
 * Each draw-down is also written to credit_applications against the payment it
 * came off. Without that link, "why was I charged $100 and not $135?" has no
 * answer in the data: `applied` records how much was spent but not against
 * what. squarePaymentId is null when credit covered the whole bill.
 */
export async function consumeCredit(
  svc: Svc, ownerKey: string, used: number, squarePaymentId?: string | null,
): Promise<void> {
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
    // Best-effort: the credit is already spent, and failing to log where it
    // went must not look like the charge failed.
    await svc.from("credit_applications").insert({
      credit_id: r.id, owner_key: ownerKey, amount: take,
      square_payment_id: squarePaymentId ?? null, applied_at: new Date().toISOString(),
    });
  }
}

/**
 * Void a show whose fee was ALREADY COLLECTED: the charge stays on the books
 * (the money really moved) and an approved credit for that fee is issued, so
 * it comes off the client's next charge. Used by the Void button
 * (/api/ppa/charge) and by an approved deposit refund (/api/refunds/decide —
 * owner 11/09/2026: a refunded deposit means the client didn't come).
 * client_credits.appt_id is unique, so a show is never credited twice.
 */
export async function voidCollectedShow(svc: Svc, o: {
  apptId: string; ownerKey: string; reason: string; fee: number; actor: string | null; now: string;
  contactName?: string | null; clientLabel?: string | null;
}): Promise<{ row: Record<string, unknown>; credited: number; error?: string }> {
  const row: Record<string, unknown> = {
    appt_id: o.apptId, owner_key: o.ownerKey,
    excluded: true, exclude_reason: o.reason, excluded_at: o.now, excluded_by: o.actor, updated_at: o.now,
  };
  const { error } = await svc.from("ppa_charges").upsert(row, { onConflict: "appt_id" });
  if (error) return { row, credited: 0, error: error.message };

  const label = o.reason === "no_show" ? "No-show"
    : o.reason === "cancelled" ? "Cancelled"
    : o.reason === "refunded" ? "Refunded" : "Voided";
  const lead = String(o.contactName ?? "").trim() || o.apptId;
  const { data: have } = await svc.from("client_credits").select("id, status").eq("appt_id", o.apptId).maybeSingle();
  if (!have) {
    const { error: cErr } = await svc.from("client_credits").insert({
      owner_key: o.ownerKey, client_label: o.clientLabel ?? null, amount: o.fee, appt_id: o.apptId,
      reason: `${label}: ${lead} — fee of $${o.fee} was already collected, credited back. Comes off the next charge.`,
      status: "approved", requested_by: o.actor, requested_at: o.now,
      decided_by: o.actor, decided_at: o.now, updated_at: o.now,
    });
    if (cErr) return { row, credited: 0, error: `voided, but the credit failed: ${cErr.message}` };
    return { row, credited: o.fee };
  }
  if (have.status !== "approved") {
    await svc.from("client_credits").update({ status: "approved", decided_by: o.actor, decided_at: o.now, updated_at: o.now }).eq("id", have.id);
    return { row, credited: o.fee };
  }
  return { row, credited: 0 };
}
