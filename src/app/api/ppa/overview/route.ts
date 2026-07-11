import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth, getV3Roster, warmStageMap } from "@/lib/ppa";

export const maxDuration = 300;

// V3 pay-per-appointment billing overview — one row per V3 client with deposit
// counts (potential appointments), pipeline stage context (served / organized),
// their fee config, and how much has been charged so far. Admin only.

type StageRow = {
  owner_key: string; location_id: string | null; total_opps: number;
  session_done: number; five_star: number; deposit_stage: number;
  first_stage: number; unmapped: number;
};

export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const svc = createServiceClient();
  const roster = await getV3Roster();
  const ownerKeys = roster.map((c) => c.ownerKey);
  const bizNorms = roster.map((c) => c.bizNorm).filter(Boolean);

  // Stage counts (pass 1) → discover each client's location, then warm the cache.
  const { data: pre } = await svc.from("ppa_stage_counts").select("*").in("owner_key", ownerKeys);
  const locations = ((pre ?? []) as StageRow[]).map((r) => r.location_id).filter(Boolean) as string[];
  const refresh = req.nextUrl.searchParams.get("refresh") === "1";
  await warmStageMap(locations, refresh);

  // Re-read everything now that stage names are cached.
  const [stageRes, depRes, cfgRes, chgRes] = await Promise.all([
    svc.from("ppa_stage_counts").select("*").in("owner_key", ownerKeys),
    svc.from("ppa_deposit_counts").select("*").in("biz_norm", bizNorms),
    svc.from("ppa_config").select("*").in("owner_key", ownerKeys),
    svc.from("ppa_charges").select("owner_key, charged, amount").in("owner_key", ownerKeys),
  ]);

  const stageBy = new Map<string, StageRow>();
  for (const r of (stageRes.data ?? []) as StageRow[]) stageBy.set(r.owner_key, r);

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
    const s = stageBy.get(c.ownerKey);
    const dep = depBy.get(c.bizNorm) ?? { deposits: 0, deposit_total: 0 };
    const cfg = cfgBy.get(c.ownerKey) ?? { is_ppa: false, fee_per_appt: 30, note: null };
    const chg = chgBy.get(c.ownerKey) ?? { count: 0, amount: 0 };
    const sessionDone = s?.session_done ?? 0;
    const fiveStar = s?.five_star ?? 0;
    const served = sessionDone + fiveStar;
    const totalOpps = s?.total_opps ?? 0;
    const firstStage = s?.first_stage ?? 0;
    const unmapped = s?.unmapped ?? 0;
    // "Organized" = they actually progress leads (some served) and the intake
    // stage isn't swallowing nearly everything.
    const organized = served > 0 && (totalOpps === 0 || firstStage / totalOpps < 0.9);
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
      sessionDone,
      fiveStar,
      firstStage,
      totalOpps,
      unmapped,
      organized,
      chargedCount: chg.count,
      chargedAmount: chg.amount,
      suggestedOwed: cfg.is_ppa ? dep.deposits * cfg.fee_per_appt : 0,
      outstandingCount: Math.max(0, dep.deposits - chg.count),
    };
  });

  return NextResponse.json({ clients, stageCacheReady: locations.length > 0 });
}
