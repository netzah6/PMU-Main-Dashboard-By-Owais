import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth, getPpaRoster } from "@/lib/ppa";
import { getCoachScope } from "@/lib/coach";
import { creditBalances } from "@/lib/credits";

export const maxDuration = 60;

// A Client Success Coach's slice of PPS Billing: the pay-per-show clients in
// THEIR book, and what each has actually paid us. Deliberately no pending
// money — what is still owed, the appointment list and the charge buttons stay
// with the admin (user request 2026-09-08).

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

  const credits = ownerKeys.length ? await creditBalances(svc, ownerKeys) : new Map<string, number>();

  const clients = mine.map((c) => {
    const p = paid.get(c.ownerKey);
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
    };
  });

  return NextResponse.json({
    coach: scope.coach,
    coaches: scope.coaches,
    isAdmin: auth.role === "admin",
    clients,
  });
}
