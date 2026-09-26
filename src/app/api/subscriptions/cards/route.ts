import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { listCustomerCards, lastUsedCard } from "@/lib/subscriptions";

export const maxDuration = 30;

// Every usable card a client has on file in Square, so the admin can choose
// which one a dashboard subscription charges. Also says which card would be
// used if none is chosen, so "leave it" is an informed decision.
//
// Each card carries the Square customer it sits on, because one business can
// have two payers: Bombshell Beauty is Erin Heidecke and Ayesha Ali, partners
// with a Square record and a card each (owner, 2026-09-26). Cards are labelled
// with the person they belong to so the two are told apart, and with more than
// one payer nothing is offered as "the default" — there is no right guess, so
// `mustChoose` asks the admin to say whose card this subscription charges.
export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth || auth.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const ownerKey = (req.nextUrl.searchParams.get("ownerKey") ?? "").trim().toLowerCase();
  if (!ownerKey) return NextResponse.json({ error: "ownerKey required" }, { status: 400 });

  const svc = createServiceClient();
  const found = await listCustomerCards(svc, ownerKey);
  if ("error" in found) return NextResponse.json({ error: found.error }, { status: 404 });

  const people = found.customers;
  const cards = people.flatMap((p) =>
    p.cards.map((c) => ({
      id: c.id,
      customerId: p.customerId,
      person: p.name,
      personEmail: p.email,
      brand: c.brand,
      last4: c.last4,
      exp: c.expMonth && c.expYear ? `${String(c.expMonth).padStart(2, "0")}/${String(c.expYear).slice(-2)}` : null,
      holder: c.cardholderName,
      enabled: c.enabled !== false,
    }))
  );

  // Default: the pinned card, else the card she last paid with, else the
  // newest enabled card — but only while ONE person pays. With two payers the
  // card a charge would fall back to is a coin toss, so there is no default.
  const one = people.length === 1 ? people[0] : null;
  const last = one && !found.pinnedCardId
    ? await lastUsedCard(one.customerId, one.cards.filter((c) => c.enabled !== false))
    : null;
  const defaultCardId = found.pinnedCardId ?? last?.id ?? (one ? cards.find((c) => c.enabled)?.id ?? null : null);

  return NextResponse.json({
    customerId: one?.customerId ?? found.pinnedCustomerId ?? null,
    people: people.map((p) => ({ customerId: p.customerId, name: p.name, email: p.email })),
    cards,
    defaultCardId,
    pinnedInPps: !!found.pinnedCardId,
    lastUsed: !!last,
    mustChoose: people.length > 1,
  });
}
