import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth, getPpaRoster } from "@/lib/ppa";
import { exemptOwnerKeys, keepFeeBlocks, ppaKeepFeeBizNorms, refundBizNorm, type KeepFeeRefund } from "@/lib/refund-keep-fee";

// List all deposit-refund requests (queue + per-deposit status). Signed-in users.
// Admins also get, for "Refund · keep PPA fee" (owner, 11/11/2026):
//   keepFeeBiz     — businesses (normalized) that may use it: V3 + pay-per-appointment
//   keepFeeBlocked — refund id → why it must not be used for that refund
// Both stay empty until the keep_ppa_fee column exists, and on any read error,
// so the button never shows when the choice can't be stored or checked.
export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const svc = createServiceClient();
  const { data, error } = await svc.from("deposit_refunds").select("*").order("requested_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let keepFeeBiz: string[] = [];
  let keepFeeBlocked: Record<string, string> = {};
  if (auth.role === "admin") {
    try {
      const { error: colErr } = await svc.from("deposit_refunds").select("keep_ppa_fee").limit(1);
      if (!colErr) {
        const [{ clients }, exempt] = await Promise.all([getPpaRoster(), exemptOwnerKeys(svc)]);
        const allowed = ppaKeepFeeBizNorms(clients, exempt);
        const open = ((data ?? []) as Array<KeepFeeRefund & { status: string }>)
          .filter((r) => (r.status === "pending" || r.status === "failed") && allowed.includes(refundBizNorm(r.business)));
        keepFeeBlocked = Object.fromEntries(await keepFeeBlocks(svc, open));
        keepFeeBiz = allowed;
      }
    } catch { keepFeeBiz = []; keepFeeBlocked = {}; /* can't check → no keep-fee button; the normal refund still works */ }
  }
  return NextResponse.json({ refunds: data ?? [], role: auth.role, keepFeeBiz, keepFeeBlocked });
}
