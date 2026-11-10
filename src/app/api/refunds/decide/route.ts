import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { refundDepositByProduct, parseAmountCents } from "@/lib/fanbasis";
import { voidCollectedShow } from "@/lib/credits";

export const maxDuration = 60;

// Admin decision on a pending refund. Approve → execute the Fanbasis refund
// (the ONLY place money moves, and only on an explicit admin approval). Deny →
// mark denied. Guards against refunding the same deposit twice.
export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Only an admin can approve refunds" }, { status: 403 });

  const b = (await req.json().catch(() => ({}))) as { id?: string; decision?: string };
  const id = String(b.id ?? "");
  const decision = String(b.decision ?? "");
  if (!id || !["approve", "deny"].includes(decision)) {
    return NextResponse.json({ error: "id and decision (approve|deny) required" }, { status: 400 });
  }

  const svc = createServiceClient();
  const { data: refund } = await svc.from("deposit_refunds").select("*").eq("id", id).maybeSingle();
  if (!refund) return NextResponse.json({ error: "refund not found" }, { status: 404 });
  if (refund.status === "refunded") return NextResponse.json({ error: "Already refunded." }, { status: 409 });

  const now = new Date().toISOString();

  if (decision === "deny") {
    if (!["pending", "failed"].includes(refund.status)) return NextResponse.json({ error: `Cannot deny a ${refund.status} refund.` }, { status: 409 });
    const { data, error } = await svc.from("deposit_refunds")
      .update({ status: "denied", decided_by: auth.email, decided_at: now, updated_at: now })
      .eq("id", id).select().single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, refund: data });
  }

  // approve — allowed from pending or a previous failed attempt (retry).
  if (!["pending", "failed"].includes(refund.status)) {
    return NextResponse.json({ error: `Cannot approve a ${refund.status} refund.` }, { status: 409 });
  }

  // Full refund of the collected deposit (amount_cents is a documented field).
  const amountCents = parseAmountCents(refund.amount ?? "") ?? undefined;
  const res = await refundDepositByProduct(refund.product_id ?? "", refund.email ?? "", { reason: refund.reason ?? undefined, amountCents });
  const update = res.ok
    ? { status: "refunded", fanbasis_transaction_id: res.transactionId ?? null, fanbasis_result: res.result ?? null, error: null, decided_by: auth.email, decided_at: now, updated_at: now }
    // Persist the attempted transaction id + what we looked up so a failed retry is diagnosable.
    : { status: "failed", fanbasis_transaction_id: res.transactionId ?? null, fanbasis_result: res.diagnostic ?? null, error: res.error ?? "refund failed", decided_by: auth.email, decided_at: now, updated_at: now };

  const { data, error } = await svc.from("deposit_refunds").update(update).eq("id", id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Owner 11/09/2026: a refunded deposit means the client didn't come, so she
  // is never billed. The views already stop future charges; this covers a
  // show fee that was collected BEFORE the refund (charge first, refund
  // later): it becomes an approved credit off the artist's next charge.
  // Best-effort — the refund itself already went through.
  let credited = 0;
  let creditError: string | undefined;
  if (res.ok) {
    try {
      const r = await creditFeesForRefund(svc, refund, auth.email, now);
      credited = r.credited;
      creditError = r.error;
    } catch (e) {
      creditError = e instanceof Error ? e.message : String(e);
    }
  }
  return NextResponse.json({ ok: res.ok, refund: data, error: res.ok ? undefined : res.error, credited, creditError });
}

type Svc = ReturnType<typeof createServiceClient>;
const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const clean = (v: unknown) => String(v ?? "").trim().toLowerCase();

/** Credit back every collected show fee on the deposit this refund covers. */
async function creditFeesForRefund(
  svc: Svc,
  refund: { business: string | null; email: string | null; deposit_date: string | null; contact_name: string | null },
  actor: string | null,
  now: string,
): Promise<{ credited: number; error?: string }> {
  // Same key as the ppa_refunded_deposits view: business + email + deposit date.
  const { data: rows } = await svc.from("ppa_deposit_rows")
    .select("appt_id, email, deposit_date")
    .eq("biz_norm", norm(refund.business));
  const ids = [...new Set(((rows ?? []) as Array<{ appt_id: string; email: string | null; deposit_date: string | null }>)
    .filter((r) => clean(r.email) === clean(refund.email) && String(r.deposit_date ?? "").trim() === String(refund.deposit_date ?? "").trim())
    .map((r) => r.appt_id))];
  if (!ids.length) return { credited: 0 };
  // Only deposits the view itself calls refunded (a refunded duplicate copy
  // of a deposit she still has is not).
  const { data: refunded } = await svc.from("ppa_refunded_deposits").select("appt_id").in("appt_id", ids);
  const refundedIds = ((refunded ?? []) as Array<{ appt_id: string }>).map((r) => r.appt_id);
  if (!refundedIds.length) return { credited: 0 };
  const { data: charges } = await svc.from("ppa_charges")
    .select("appt_id, owner_key, amount, charged, excluded")
    .in("appt_id", refundedIds).eq("charged", true);
  let credited = 0;
  for (const c of (charges ?? []) as Array<{ appt_id: string; owner_key: string; amount: number | null; charged: boolean; excluded: boolean | null }>) {
    const fee = Number(c.amount) || 0;
    // Already voided (and credited by the Void button) — leave its reason alone.
    if (fee <= 0 || c.excluded) continue;
    const v = await voidCollectedShow(svc, {
      apptId: c.appt_id, ownerKey: c.owner_key, reason: "refunded", fee, actor, now,
      contactName: refund.contact_name, clientLabel: refund.business,
    });
    if (v.error) return { credited, error: v.error };
    credited += v.credited;
  }
  return { credited };
}
