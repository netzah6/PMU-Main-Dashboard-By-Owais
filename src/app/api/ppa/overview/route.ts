import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth, getPpaRoster, warmStageMap, ingestAppointments } from "@/lib/ppa";

export const maxDuration = 300;

// V3 pay-per-appointment billing overview — one row per V3 client. All counts
// are DEPOSIT-LINKED and time-aware: each deposit is resolved to its lead's
// stage AND scheduled appointment, so "ready to charge" = appointments that
// actually happened (served or past-due) and aren't charged yet. Admin only.

type LocRow = { owner_key: string; location_id: string | null };
type SummaryRow = {
  owner_key: string; served: number; past_due: number; upcoming: number;
  noshow: number; no_appt: number; ready_to_charge: number; charged_count: number;
};

export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const svc = createServiceClient();
  const { clients: roster, missingFromMaster } = await getPpaRoster();
  const ownerKeys = roster.map((c) => c.ownerKey);
  const bizNorms = roster.map((c) => c.bizNorm).filter(Boolean);

  // On refresh: re-warm stage names AND re-pull calendar appointments for all
  // deposit leads (~330 contacts, ~30s). Normal loads read the cached tables.
  const refresh = req.nextUrl.searchParams.get("refresh") === "1";
  const { data: locs } = await svc.from("ppa_stage_counts").select("owner_key, location_id").in("owner_key", ownerKeys);
  const locations = ((locs ?? []) as LocRow[]).map((r) => r.location_id).filter(Boolean) as string[];
  await warmStageMap(locations, refresh);
  if (refresh) { await ingestAppointments(); await svc.rpc("refresh_ppa_facts"); }

  const [sumRes, depRes, cfgRes, chgRes] = await Promise.all([
    svc.from("ppa_billing_summary").select("*").in("owner_key", ownerKeys),
    svc.from("ppa_deposit_counts").select("*").in("biz_norm", bizNorms),
    svc.from("ppa_config").select("*").in("owner_key", ownerKeys),
    svc.from("ppa_charges").select("owner_key, charged, amount").in("owner_key", ownerKeys),
  ]);

  const sumBy = new Map<string, SummaryRow>();
  for (const r of (sumRes.data ?? []) as SummaryRow[]) sumBy.set(r.owner_key, r);

  const depBy = new Map<string, { deposits: number; deposit_total: number }>();
  for (const r of (depRes.data ?? []) as Array<{ biz_norm: string; deposits: number; deposit_total: number }>)
    depBy.set(r.biz_norm, { deposits: Number(r.deposits) || 0, deposit_total: Number(r.deposit_total) || 0 });

  const cfgBy = new Map<string, { is_ppa: boolean; fee_per_appt: number; note: string | null }>();
  for (const r of (cfgRes.data ?? []) as Array<{ owner_key: string; is_ppa: boolean; fee_per_appt: number; note: string | null }>)
    cfgBy.set(r.owner_key, { is_ppa: !!r.is_ppa, fee_per_appt: Number(r.fee_per_appt), note: r.note });

  const chgAmtBy = new Map<string, number>();
  for (const r of (chgRes.data ?? []) as Array<{ owner_key: string; charged: boolean; amount: number | null }>) {
    if (!r.charged) continue;
    chgAmtBy.set(r.owner_key, (chgAmtBy.get(r.owner_key) ?? 0) + (Number(r.amount) || 0));
  }

  const clients = roster.map((c) => {
    const s = sumBy.get(c.ownerKey);
    const dep = depBy.get(c.bizNorm) ?? { deposits: 0, deposit_total: 0 };
    const cfg = cfgBy.get(c.ownerKey) ?? { is_ppa: false, fee_per_appt: 30, note: null };
    const readyToCharge = s?.ready_to_charge ?? 0;
    return {
      ownerKey: c.ownerKey,
      ownerName: c.ownerName,
      business: c.business,
      status: c.status,
      version: c.version,
      // The roster only contains PPA-marked clients now, so everyone bills
      // per appointment — the old per-client toggle is meaningless.
      isPpa: true,
      fee: cfg.fee_per_appt,
      note: cfg.note,
      deposits: dep.deposits,
      depositTotal: dep.deposit_total,
      served: s?.served ?? 0,
      pastDue: s?.past_due ?? 0,
      upcoming: s?.upcoming ?? 0,
      noshow: s?.noshow ?? 0,
      noAppt: s?.no_appt ?? 0,
      readyToCharge,
      chargedCount: s?.charged_count ?? 0,
      chargedAmount: chgAmtBy.get(c.ownerKey) ?? 0,
      readyOwed: readyToCharge * cfg.fee_per_appt,
    };
  });

  return NextResponse.json({ clients, missingFromMaster });
}
