import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth, getV3Roster, warmStageMap } from "@/lib/ppa";

export const maxDuration = 300;

// V3 pay-per-appointment billing overview — one row per V3 client. "Served" and
// "stuck" are DEPOSIT-LINKED: each deposit is resolved to its own lead's current
// pipeline stage, so the numbers describe the deposits shown, not unrelated
// opportunities elsewhere in the pipeline. Admin only.

type LocRow = { owner_key: string; location_id: string | null };
type DepStageRow = {
  owner_key: string; deposits_matched: number; deposits_in_pipeline: number;
  dep_session_done: number; dep_five_star: number; dep_served: number; dep_first_stage: number;
};

export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const svc = createServiceClient();
  const roster = await getV3Roster();
  const ownerKeys = roster.map((c) => c.ownerKey);
  const bizNorms = roster.map((c) => c.bizNorm).filter(Boolean);

  // Discover each client's location (to warm the stage-name cache).
  const { data: locs } = await svc.from("ppa_stage_counts").select("owner_key, location_id").in("owner_key", ownerKeys);
  const locations = ((locs ?? []) as LocRow[]).map((r) => r.location_id).filter(Boolean) as string[];
  const refresh = req.nextUrl.searchParams.get("refresh") === "1";
  await warmStageMap(locations, refresh);

  const [depStageRes, depRes, cfgRes, chgRes] = await Promise.all([
    svc.from("ppa_deposit_stage_counts").select("*").in("owner_key", ownerKeys),
    svc.from("ppa_deposit_counts").select("*").in("biz_norm", bizNorms),
    svc.from("ppa_config").select("*").in("owner_key", ownerKeys),
    svc.from("ppa_charges").select("owner_key, charged, amount").in("owner_key", ownerKeys),
  ]);

  const depStageBy = new Map<string, DepStageRow>();
  for (const r of (depStageRes.data ?? []) as DepStageRow[]) depStageBy.set(r.owner_key, r);

  const depBy = new Map<string, { deposits: number; deposit_total: number }>();
  for (const r of (depRes.data ?? []) as Array<{ biz_norm: string; deposits: number; deposit_total: number }>)
    depBy.set(r.biz_norm, { deposits: Number(r.deposits) || 0, deposit_total: Number(r.deposit_total) || 0 });

  const cfgBy = new Map<string, { is_ppa: boolean; fee_per_appt: number; note: string | null }>();
  for (const r of (cfgRes.data ?? []) as Array<{ owner_key: string; is_ppa: boolean; fee_per_appt: number; note: string | null }>)
    cfgBy.set(r.owner_key, { is_ppa: !!r.is_ppa, fee_per_appt: Number(r.fee_per_appt), note: r.note });

  const chgBy = new Map<string, { count: number; amount: number }>();
  for (const r of (chgRes.data ?? []) as Array<{ owner_key: string; charged: boolean; amount: number | null }>) {
    if (!r.charged) continue;
    const cur = chgBy.get(r.owner_key) ?? { count: 0, amount: 0 };
    cur.count += 1;
    cur.amount += Number(r.amount) || 0;
    chgBy.set(r.owner_key, cur);
  }

  const clients = roster.map((c) => {
    const ds = depStageBy.get(c.ownerKey);
    const dep = depBy.get(c.bizNorm) ?? { deposits: 0, deposit_total: 0 };
    const cfg = cfgBy.get(c.ownerKey) ?? { is_ppa: false, fee_per_appt: 30, note: null };
    const chg = chgBy.get(c.ownerKey) ?? { count: 0, amount: 0 };
    const served = ds?.dep_served ?? 0;                 // deposits whose lead reached Session Done / 5-Star
    const stuck = ds?.dep_first_stage ?? 0;             // deposits still in the first stage
    const inPipeline = ds?.deposits_in_pipeline ?? 0;   // deposits matched to a pipeline stage
    // "Not organized" = deposits present but (almost) none progressed past the
    // first stage — the case where you charge for every deposit anyway.
    const organized = inPipeline > 0 && stuck < inPipeline;
    return {
      ownerKey: c.ownerKey,
      ownerName: c.ownerName,
      business: c.business,
      status: c.status,
      version: c.version,
      isPpa: cfg.is_ppa,
      fee: cfg.fee_per_appt,
      note: cfg.note,
      deposits: dep.deposits,
      depositTotal: dep.deposit_total,
      served,
      sessionDone: ds?.dep_session_done ?? 0,
      fiveStar: ds?.dep_five_star ?? 0,
      stuck,
      inPipeline,
      organized,
      chargedCount: chg.count,
      chargedAmount: chg.amount,
      suggestedOwed: cfg.is_ppa ? dep.deposits * cfg.fee_per_appt : 0,
      outstandingCount: Math.max(0, dep.deposits - chg.count),
    };
  });

  return NextResponse.json({ clients });
}
