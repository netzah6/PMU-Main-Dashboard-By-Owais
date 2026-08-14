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
  return /DECLINE|INSUFFICIENT|CVV|EXPIR|INVALID_CARD|CARD_NOT_SUPPORTED|VERIFY/i.test(message);
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
