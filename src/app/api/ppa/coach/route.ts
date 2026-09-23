import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth, getPpaRoster } from "@/lib/ppa";
import { buildPpaClients } from "@/lib/ppa-overview";
import { buildVerifyReport } from "@/lib/ppa-verify";
import { squareConfigured } from "@/lib/square";
import { getCoachScope } from "@/lib/coach";
import { creditBalances } from "@/lib/credits";

// A Client Success Coach's slice of PPS Billing: the pay-per-show clients in
// THEIR book, what each has paid us, and — since 2026-09-23, at the owner's
// request — what is still to be charged on their upcoming appointments: the
// fee, the deposits charged, Upcoming / Ready / Self-booked / No appointment,
// and whether a card is on file.
//
// This REVERSES the 2026-09-08 "no pending money" rule for the coach view. What
// stays admin-only is the ACTION, not the number: no charge buttons, no
// appointment-level amounts, no Square write path is reachable from here.
//
// The counts come from buildPpaClients() — the same code the admin table uses —
// so a coach and an admin can never read different money off the same client.
export const maxDuration = 300;

// ?cards=1 is a second, slower pass (~2 Square reads per client). The table
// renders without it and fills the column in when it lands.
async function cardStatus(ownerKeys: Set<string>) {
  if (!squareConfigured() || ownerKeys.size === 0) return [];
  const report = await buildVerifyReport(ownerKeys);
  return report.clients.map((v) => {
    const card = v.cards.find((c) => c.wouldCharge) ?? null;
    return {
      ownerKey: v.ownerKey,
      hasCard: !!card,
      brand: card?.brand ?? null,
      last4: card?.last4 ?? null,
      // Why there is no usable card, in the coach's words — they are the ones
      // who have to ask the client to update it.
      reason: card ? null : !v.match ? "No Square customer" : v.cards.length ? "No usable card" : "No card on file",
    };
  });
}

export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin" && auth.role !== "editor") {
    return NextResponse.json({ error: "Coaches and admins only" }, { status: 403 });
  }

  const svc = createServiceClient();
  const requested = (req.nextUrl.searchParams.get("coach") ?? "").trim();
  const [scope, roster] = await Promise.all([
    getCoachScope(svc, auth, requested),
    getPpaRoster(),
  ]);

  const mine = roster.clients.filter((c) => !scope.ownerKeys || scope.ownerKeys.has(c.ownerKey));
  const ownerKeys = mine.map((c) => c.ownerKey);
  const ownerKeySet = new Set(ownerKeys);

  if (req.nextUrl.searchParams.get("cards") === "1") {
    try {
      return NextResponse.json({ cards: await cardStatus(ownerKeySet) });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Card check failed" }, { status: 502 });
    }
  }

  type ChargeRow = { owner_key: string; amount: number | null; charged_at: string | null };
  const paid = new Map<string, { shows: number; total: number; last: string | null }>();
  if (ownerKeys.length) {
    const { data } = await svc
      .from("ppa_charges")
      .select("owner_key, amount, charged_at")
      .eq("charged", true)
      .in("owner_key", ownerKeys);
    for (const r of (data ?? []) as ChargeRow[]) {
      const p = paid.get(r.owner_key) ?? { shows: 0, total: 0, last: null };
      p.shows++;
      p.total += Number(r.amount) || 0;
      if ((r.charged_at ?? "") > (p.last ?? "")) p.last = r.charged_at;
      paid.set(r.owner_key, p);
    }
  }

  const [credits, billing] = await Promise.all([
    ownerKeys.length ? creditBalances(svc, ownerKeys) : Promise.resolve(new Map<string, number>()),
    ownerKeys.length ? buildPpaClients(mine) : Promise.resolve([]),
  ]);
  const billBy = new Map(billing.map((b) => [b.ownerKey, b]));

  const clients = mine.map((c) => {
    const p = paid.get(c.ownerKey);
    const b = billBy.get(c.ownerKey);
    return {
      ownerKey: c.ownerKey,
      ownerName: c.ownerName,
      business: c.business,
      status: c.status,
      coach: scope.coachByOwner.get(c.ownerKey) ?? "",
      shows: p?.shows ?? 0,
      paid: p?.total ?? 0,
      lastChargedAt: p?.last ?? null,
      credit: credits.get(c.ownerKey) ?? 0,
      // What is still to be charged (owner request 2026-09-23).
      fee: b?.fee ?? 0,
      feeSource: b?.feeSource ?? null,
      deposits: b?.deposits ?? 0,
      refundedCount: b?.refundedCount ?? 0,
      chargedCount: b?.chargedCount ?? 0,
      chargedAmount: b?.chargedAmount ?? 0,
      upcoming: b?.upcoming ?? 0,
      readyToCharge: b?.readyToCharge ?? 0,
      readyOwed: b?.readyOwed ?? 0,
      selfBooked: b?.selfBooked ?? 0,
      selfBookedReady: b?.selfBookedReady ?? 0,
      noAppt: b?.noAppt ?? 0,
      billingExempt: b?.billingExempt ?? false,
    };
  });

  return NextResponse.json({
    coach: scope.coach,
    coaches: scope.coaches,
    isAdmin: auth.role === "admin",
    cardsAvailable: squareConfigured(),
    clients,
  });
}
