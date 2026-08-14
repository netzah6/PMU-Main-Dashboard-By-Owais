import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { listCards } from "@/lib/square";

// Set (or clear) the admin-chosen default card for a PPS client. The choice is
// validated against Square right now — you can only pick a card that actually
// exists on that customer — and re-validated again at charge time.
export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as {
    owner_key?: string; customer_id?: string; card_id?: string; clear?: boolean;
  };
  const ownerKey = String(body.owner_key ?? "").trim().toLowerCase();
  if (!ownerKey) return NextResponse.json({ error: "owner_key required" }, { status: 400 });

  const svc = createServiceClient();

  if (body.clear) {
    const { error } = await svc.from("ppa_card_prefs").delete().eq("owner_key", ownerKey);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, cleared: true });
  }

  const customerId = String(body.customer_id ?? "").trim();
  const cardId = String(body.card_id ?? "").trim();
  if (!customerId || !cardId) return NextResponse.json({ error: "customer_id and card_id required" }, { status: 400 });

  let label: string | null = null;
  try {
    const cards = await listCards(customerId);
    const card = cards.find((c) => c.id === cardId);
    if (!card) return NextResponse.json({ error: "That card is not on file for this Square customer." }, { status: 400 });
    if (!card.enabled) return NextResponse.json({ error: "That card is disabled in Square." }, { status: 400 });
    label = `${card.brand} ••${card.last4}`;
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Square lookup failed" }, { status: 502 });
  }

  const { error } = await svc.from("ppa_card_prefs").upsert({
    owner_key: ownerKey,
    customer_id: customerId,
    card_id: cardId,
    card_label: label,
    chosen_by: auth.email,
    chosen_at: new Date().toISOString(),
  }, { onConflict: "owner_key" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, label });
}
