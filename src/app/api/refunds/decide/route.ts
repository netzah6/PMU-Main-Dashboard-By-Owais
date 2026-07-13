import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { refundDepositByProduct, parseAmountCents } from "@/lib/fanbasis";

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
  return NextResponse.json({ ok: res.ok, refund: data, error: res.ok ? undefined : res.error });
}
