import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { creditBalances } from "@/lib/credits";

export const maxDuration = 60;

// A Client Success Coach's own book of business: the clients assigned to them,
// how those clients are performing, and what each one has actually paid us.
// Admins can look at any coach's book via ?coach=.

type PerfRow = {
  owner_name: string | null; business_name: string | null; assigned: string | null;
  media_buyer: string | null; client_status: string | null; daily_budget: number | null;
  booking_pct: number | null; l30: number | null; l7: number | null;
  cpl30: number | null; spent_all: number | null; spent14: number | null;
  sessions_done: number | null; campaign_paused: boolean | null;
};

/** "stephanie@pmu-bookings.com" → "stephanie": the Assigned column holds first names. */
function coachNameFromEmail(email: string | null | undefined): string {
  return String(email ?? "").split("@")[0].replace(/[^a-z]/gi, "").toLowerCase();
}

export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin" && auth.role !== "editor") {
    return NextResponse.json({ error: "Coaches and admins only" }, { status: 403 });
  }
  const svc = createServiceClient();

  const { data: perf } = await svc
    .from("performance_overview")
    .select("owner_name, business_name, assigned, media_buyer, client_status, daily_budget, booking_pct, l30, l7, cpl30, spent_all, spent14, sessions_done, campaign_paused");
  const rows = (perf ?? []) as PerfRow[];

  // Which book to show. Coaches always see their own; admins may pass ?coach=.
  const coaches = [...new Set(rows.map((r) => (r.assigned ?? "").trim()).filter(Boolean))].sort();
  const requested = (req.nextUrl.searchParams.get("coach") ?? "").trim();
  const mine = coachNameFromEmail(auth.email);
  const matchByName = (name: string) => name.replace(/[^a-z]/gi, "").toLowerCase() === mine;
  const own = coaches.find(matchByName) ?? "";
  const coach = auth.role === "admin" && requested ? requested : own;

  const clients = rows
    .filter((r) => (r.assigned ?? "").trim().toLowerCase() === coach.toLowerCase() && coach !== "")
    .map((r) => ({
      ownerKey: String(r.owner_name ?? "").trim().toLowerCase(),
      ownerName: r.owner_name ?? "",
      business: r.business_name ?? "",
      status: r.client_status ?? "",
      mediaBuyer: r.media_buyer ?? "",
      dailyBudget: Number(r.daily_budget) || 0,
      bookingPct: r.booking_pct == null ? null : Number(r.booking_pct),
      leads30: Number(r.l30) || 0,
      leads7: Number(r.l7) || 0,
      cpl30: r.cpl30 == null ? null : Number(r.cpl30),
      spentAll: Number(r.spent_all) || 0,
      spent14: Number(r.spent14) || 0,
      sessionsDone: Number(r.sessions_done) || 0,
      paused: !!r.campaign_paused,
    }))
    .sort((a, b) => a.ownerName.localeCompare(b.ownerName));

  const ownerKeys = clients.map((c) => c.ownerKey).filter(Boolean);

  // What each client actually paid: service-fee charges grouped into the
  // payment that collected them, newest first.
  type ChargeRow = { owner_key: string; amount: number | null; charged: boolean | null; charged_at: string | null; charged_by: string | null; square_payment_id: string | null };
  const receiptsByOwner: Record<string, Array<{ paymentId: string | null; chargedAt: string | null; chargedBy: string | null; shows: number; total: number; manual: boolean; receiptUrl: string | null }>> = {};
  if (ownerKeys.length) {
    const { data: chg } = await svc
      .from("ppa_charges")
      .select("owner_key, amount, charged, charged_at, charged_by, square_payment_id")
      .in("owner_key", ownerKeys)
      .eq("charged", true);
    const groups = new Map<string, { ownerKey: string; paymentId: string | null; chargedAt: string | null; chargedBy: string | null; shows: number; total: number; manual: boolean }>();
    for (const r of (chg ?? []) as ChargeRow[]) {
      const key = `${r.owner_key}|${r.square_payment_id ?? `manual:${(r.charged_at ?? "").slice(0, 16)}:${r.charged_by ?? ""}`}`;
      const g = groups.get(key) ?? {
        ownerKey: r.owner_key, paymentId: r.square_payment_id ?? null,
        chargedAt: r.charged_at, chargedBy: r.charged_by,
        shows: 0, total: 0, manual: !r.square_payment_id,
      };
      g.shows++;
      g.total += Number(r.amount) || 0;
      if ((r.charged_at ?? "") > (g.chargedAt ?? "")) g.chargedAt = r.charged_at;
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      (receiptsByOwner[g.ownerKey] ??= []).push({
        paymentId: g.paymentId, chargedAt: g.chargedAt, chargedBy: g.chargedBy,
        shows: g.shows, total: g.total, manual: g.manual,
        receiptUrl: g.paymentId ? `https://squareup.com/receipt/preview/${g.paymentId}` : null,
      });
    }
    for (const list of Object.values(receiptsByOwner)) {
      list.sort((a, b) => String(b.chargedAt ?? "").localeCompare(String(a.chargedAt ?? "")));
    }
  }

  const credits = ownerKeys.length ? await creditBalances(svc, ownerKeys) : new Map<string, number>();

  return NextResponse.json({
    coach,
    isAdmin: auth.role === "admin",
    coaches,
    clients,
    receipts: receiptsByOwner,
    credits: Object.fromEntries(credits),
  });
}
