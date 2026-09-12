import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { listCards } from "@/lib/square";
import { resolveCustomer } from "@/lib/subscriptions";

export const maxDuration = 30;

// Every usable card a client has on file in Square, so the admin can choose
// which one a dashboard subscription charges. Also says which card would be
// used if none is chosen, so "leave it" is an informed decision.
export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth || auth.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const ownerKey = (req.nextUrl.searchParams.get("ownerKey") ?? "").trim().toLowerCase();
  if (!ownerKey) return NextResponse.json({ error: "ownerKey required" }, { status: 400 });

  const svc = createServiceClient();
  const cust = await resolveCustomer(svc, ownerKey);
  if ("error" in cust) return NextResponse.json({ error: cust.error }, { status: 404 });

  const cards = (await listCards(cust.customerId, true)).map((c) => ({
    id: c.id,
    brand: c.brand,
    last4: c.last4,
    exp: c.expMonth && c.expYear ? `${String(c.expMonth).padStart(2, "0")}/${String(c.expYear).slice(-2)}` : null,
    holder: c.cardholderName,
    enabled: c.enabled !== false,
  }));
  const defaultCardId = cust.pinnedCardId ?? cards.find((c) => c.enabled)?.id ?? null;
  return NextResponse.json({ customerId: cust.customerId, cards, defaultCardId, pinnedInPps: !!cust.pinnedCardId });
}
