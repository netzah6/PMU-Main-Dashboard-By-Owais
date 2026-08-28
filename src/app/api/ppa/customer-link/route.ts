import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";

// Set or clear the manual client → Square-customer link. The link overrides
// automatic matching entirely (method "manual" in the payment check). Clearing
// it also clears any card pick, since the pick belongs to the linked profile.
export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as {
    owner_key?: string; customer_id?: string; customer_label?: string; clear?: boolean;
  };
  const ownerKey = String(body.owner_key ?? "").trim().toLowerCase();
  if (!ownerKey) return NextResponse.json({ error: "owner_key required" }, { status: 400 });

  const svc = createServiceClient();
  if (body.clear) {
    await svc.from("ppa_customer_links").delete().eq("owner_key", ownerKey);
    await svc.from("ppa_card_prefs").delete().eq("owner_key", ownerKey);
    return NextResponse.json({ ok: true, cleared: true });
  }

  const customerId = String(body.customer_id ?? "").trim();
  if (!customerId) return NextResponse.json({ error: "customer_id required" }, { status: 400 });

  // A new link invalidates any card pick made on the previously-linked or
  // auto-matched profile.
  await svc.from("ppa_card_prefs").delete().eq("owner_key", ownerKey).neq("customer_id", customerId);
  const { error } = await svc.from("ppa_customer_links").upsert({
    owner_key: ownerKey,
    customer_id: customerId,
    customer_label: body.customer_label?.slice(0, 200) ?? null,
    linked_by: auth.email,
    linked_at: new Date().toISOString(),
  }, { onConflict: "owner_key" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
