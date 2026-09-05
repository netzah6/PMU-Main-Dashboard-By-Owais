import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";

// A Client Success Coach (or an admin) asks for account credit on a client.
// Nothing is applied until an admin approves it in the queue — same rule as
// deposit refunds, because this reduces a real charge.
export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin" && auth.role !== "editor") {
    return NextResponse.json({ error: "Admins and coaches only" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    ownerKey?: string; clientLabel?: string; amount?: number | string; reason?: string;
  };
  const ownerKey = String(body.ownerKey ?? "").trim();
  const reason = String(body.reason ?? "").trim();
  const amount = Number(String(body.amount ?? "").replace(/[^0-9.]/g, ""));
  if (!ownerKey) return NextResponse.json({ error: "ownerKey required" }, { status: 400 });
  if (!reason) return NextResponse.json({ error: "Say why the credit is owed" }, { status: 400 });
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: "Enter an amount greater than zero" }, { status: 400 });
  }

  const svc = createServiceClient();
  const { data, error } = await svc
    .from("client_credits")
    .insert({
      owner_key: ownerKey,
      client_label: body.clientLabel ?? null,
      amount,
      reason: reason.slice(0, 500),
      status: "pending",
      requested_by: auth.email,
      requested_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, credit: data });
}
