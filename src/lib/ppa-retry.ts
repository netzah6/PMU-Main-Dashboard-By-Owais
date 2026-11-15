import { createServiceClient } from "@/lib/supabase/server";

// ── Automatic retry after a card decline ─────────────────────────────────────
// A declined card often starts working again (funds arrive, the bank's fraud
// hold lifts), so instead of bothering the artist immediately the charge is
// retried on a schedule the user chose: +1 day, then +3 days, then +3 days.
// Four attempts total (the original + 3 retries), then the row is 'exhausted'
// and the humans take over (new card / payment link).

export const RETRY_OFFSETS_DAYS = [1, 3, 3];

// Card-level failures worth retrying. Config errors (bad token, missing
// scope) are NOT — retrying those just fails identically.
export function isDeclineError(message: string): boolean {
  // TRANSACTION_LIMIT: the bank refused the amount for now (a card limit);
  // it often clears the next day, like any decline (Sharmila, 11/09/2026).
  return /DECLINE|INSUFFICIENT|CVV|EXPIR|INVALID_CARD|CARD_NOT_SUPPORTED|VERIFY|TRANSACTION_LIMIT/i.test(message);
}

/** A charge attempt that Square answered with a failure. Stamps
 *  last_attempt_at, which is part of the next charge's idempotency key — so
 *  the next attempt is a NEW payment the bank really sees, instead of Square
 *  replaying this failure (11/15/2026: a retry with the same shows + amount
 *  got the 11/09 decline back without ever reaching the bank). Keeps an
 *  existing retry loop's status; a client with no loop gets status "failed",
 *  which the retry cron and the billing UI ignore. */
export async function noteFailedAttempt(ownerKey: string, error: string): Promise<void> {
  const svc = createServiceClient();
  const now = new Date().toISOString();
  const { data } = await svc.from("ppa_charge_retries").select("owner_key").eq("owner_key", ownerKey).maybeSingle();
  if (data) {
    await svc.from("ppa_charge_retries").update({ last_attempt_at: now, last_error: error.slice(0, 500), updated_at: now }).eq("owner_key", ownerKey);
  } else {
    await svc.from("ppa_charge_retries").insert({
      owner_key: ownerKey, status: "failed", attempts: 0, next_attempt_at: null,
      last_attempt_at: now, last_error: error.slice(0, 500), created_by: "charge", updated_at: now,
    });
  }
}

/** The idempotency "generation" for a client's next charge: the time of the
 *  last answered failure ("" if none). Read errors fall back to "" — the old
 *  key — which can only replay, never double-charge. */
export async function failureGeneration(ownerKey: string): Promise<string> {
  try {
    const svc = createServiceClient();
    const { data } = await svc.from("ppa_charge_retries").select("last_attempt_at").eq("owner_key", ownerKey).maybeSingle();
    return (data as { last_attempt_at?: string | null } | null)?.last_attempt_at ?? "";
  } catch {
    return "";
  }
}

export interface RetryState {
  status: string;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
}

/** Start (or restart) the retry clock after a failed charge. */
export async function scheduleRetry(ownerKey: string, error: string, by: string): Promise<Date> {
  const svc = createServiceClient();
  const next = new Date(Date.now() + RETRY_OFFSETS_DAYS[0] * 24 * 3600 * 1000);
  await svc.from("ppa_charge_retries").upsert({
    owner_key: ownerKey,
    status: "active",
    attempts: 0,
    next_attempt_at: next.toISOString(),
    last_attempt_at: new Date().toISOString(),
    last_error: error.slice(0, 500),
    created_by: by,
    updated_at: new Date().toISOString(),
  }, { onConflict: "owner_key" });
  return next;
}

/** A retry attempt failed again: advance the schedule or exhaust it. */
export async function advanceRetry(ownerKey: string, attempts: number, error: string): Promise<{ status: string; nextAt: Date | null }> {
  const svc = createServiceClient();
  const done = attempts + 1; // this failure completes retry #done
  const exhausted = done >= RETRY_OFFSETS_DAYS.length;
  const nextAt = exhausted ? null : new Date(Date.now() + RETRY_OFFSETS_DAYS[done] * 24 * 3600 * 1000);
  await svc.from("ppa_charge_retries").update({
    status: exhausted ? "exhausted" : "active",
    attempts: done,
    next_attempt_at: nextAt ? nextAt.toISOString() : null,
    last_attempt_at: new Date().toISOString(),
    last_error: error.slice(0, 500),
    updated_at: new Date().toISOString(),
  }).eq("owner_key", ownerKey);
  return { status: exhausted ? "exhausted" : "active", nextAt };
}

/** Money came in (any path) — the retry loop is over. */
export async function resolveRetry(ownerKey: string, status: "succeeded" | "cancelled"): Promise<void> {
  const svc = createServiceClient();
  await svc.from("ppa_charge_retries").update({
    status,
    next_attempt_at: null,
    updated_at: new Date().toISOString(),
  }).eq("owner_key", ownerKey).eq("status", "active");
}
