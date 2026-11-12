import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth, getPpaRoster } from "@/lib/ppa";
import { ppaKeepFeeBizNorms } from "@/lib/refund-keep-fee";

// List all deposit-refund requests (queue + per-deposit status). Signed-in users.
// Admins also get `keepFeeBiz`: the businesses (normalized) where a refund can
// keep the PPA service fee — V3 clients on pay-per-appointment (owner,
// 11/11/2026). Empty until the keep_ppa_fee column exists, so the button
// never shows before the database can store the choice.
export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const svc = createServiceClient();
  const { data, error } = await svc.from("deposit_refunds").select("*").order("requested_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let keepFeeBiz: string[] = [];
  if (auth.role === "admin") {
    try {
      const { error: colErr } = await svc.from("deposit_refunds").select("keep_ppa_fee").limit(1);
      if (!colErr) keepFeeBiz = ppaKeepFeeBizNorms((await getPpaRoster()).clients);
    } catch { /* roster unreadable → no keep-fee button, the normal refund still works */ }
  }
  return NextResponse.json({ refunds: data ?? [], role: auth.role, keepFeeBiz });
}
