import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";

// A team member (editor/admin) requests a deposit refund → a pending row that
// only an admin can approve. Does not touch Fanbasis.
export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin" && auth.role !== "editor") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const b = (await req.json().catch(() => ({}))) as {
    business?: string; contact_name?: string; email?: string; amount?: string;
    product_id?: string; deposit_date?: string; reason?: string;
  };
  const email = String(b.email ?? "").trim();
  const productId = String(b.product_id ?? "").trim();
  const amount = String(b.amount ?? "").trim();
  const depositDate = String(b.deposit_date ?? "").trim();
  if (!email && !productId) return NextResponse.json({ error: "deposit email or product id required" }, { status: 400 });

  const depositKey = "r_" + createHash("md5")
    .update([productId, email, amount, depositDate].map((s) => s.toLowerCase()).join("|"))
    .digest("hex").slice(0, 24);

  const svc = createServiceClient();
  // Block a second request if one is already pending or already refunded.
  const { data: existing } = await svc.from("deposit_refunds")
    .select("id, status").eq("deposit_key", depositKey).in("status", ["pending", "refunded"]).maybeSingle();
  if (existing) {
    return NextResponse.json({ error: `This deposit already has a ${existing.status} refund.`, status: existing.status }, { status: 409 });
  }

  const row = {
    deposit_key: depositKey,
    business: b.business ?? null,
    contact_name: b.contact_name ?? null,
    email: email || null,
    amount: amount || null,
    product_id: productId || null,
    deposit_date: depositDate || null,
    reason: b.reason ?? null,
    status: "pending",
    requested_by: auth.email,
    requested_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await svc.from("deposit_refunds").insert(row).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, refund: data });
}
