import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth, getV3Roster } from "@/lib/ppa";

// Drill-down for one V3 client: every deposit (appointment) with its OWN lead's
// current pipeline stage + charge state, so the admin can see which deposits
// actually reached Session Done / 5-Star and which are stuck. Admin only.

type DepRow = {
  appt_id: string; business: string; contact_name: string | null; email: string | null;
  deposit_date: string | null; amount: string | null; status: string | null;
  notes: string | null; source: string | null;
};
type ChargeRow = {
  appt_id: string; charged: boolean; amount: number | null; note: string | null;
  charged_at: string | null; charged_by: string | null;
};
type DepStage = { appt_id: string; stage_name: string | null; position: number | null; is_session_done: boolean; is_five_star: boolean };

export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const ownerKey = (req.nextUrl.searchParams.get("owner_key") ?? "").trim().toLowerCase();
  if (!ownerKey) return NextResponse.json({ error: "owner_key required" }, { status: 400 });

  const roster = await getV3Roster();
  const client = roster.find((c) => c.ownerKey === ownerKey);
  if (!client) return NextResponse.json({ error: "not a V3 client" }, { status: 404 });

  const svc = createServiceClient();
  const [depRes, chgRes, stageRes, cfgRes] = await Promise.all([
    svc.from("ppa_deposit_rows").select("*").eq("biz_norm", client.bizNorm),
    svc.from("ppa_charges").select("*").eq("owner_key", ownerKey),
    svc.from("ppa_deposit_stage").select("appt_id, stage_name, position, is_session_done, is_five_star").eq("owner_key", ownerKey),
    svc.from("ppa_config").select("*").eq("owner_key", ownerKey).maybeSingle(),
  ]);

  const chgBy = new Map<string, ChargeRow>();
  for (const r of (chgRes.data ?? []) as ChargeRow[]) chgBy.set(r.appt_id, r);
  const stgBy = new Map<string, DepStage>();
  for (const r of (stageRes.data ?? []) as DepStage[]) stgBy.set(r.appt_id, r);

  let served = 0, stuck = 0, inPipeline = 0;
  const appointments = ((depRes.data ?? []) as DepRow[]).map((d) => {
    const c = chgBy.get(d.appt_id);
    const st = stgBy.get(d.appt_id);
    if (st?.stage_name) inPipeline++;
    if (st?.is_session_done || st?.is_five_star) served++;
    if (st?.position === 0) stuck++;
    return {
      apptId: d.appt_id,
      contactName: d.contact_name,
      email: d.email,
      depositDate: d.deposit_date,
      amount: d.amount,
      status: d.status,
      notes: d.notes,
      source: d.source,
      currentStage: st?.stage_name ?? null,
      isServed: !!(st?.is_session_done || st?.is_five_star),
      charged: c?.charged ?? false,
      chargedAmount: c?.amount ?? null,
      chargedAt: c?.charged_at ?? null,
      chargedBy: c?.charged_by ?? null,
      chargeNote: c?.note ?? null,
    };
  });
  // Newest deposits first (dates are mixed ISO / DD/MM/YYYY text — sort loosely).
  appointments.sort((a, b) => String(b.depositDate ?? "").localeCompare(String(a.depositDate ?? "")));

  const cfg = (cfgRes.data ?? null) as { is_ppa: boolean; fee_per_appt: number; note: string | null } | null;

  return NextResponse.json({
    client: {
      ownerKey: client.ownerKey,
      ownerName: client.ownerName,
      business: client.business,
      status: client.status,
      isPpa: cfg?.is_ppa ?? false,
      fee: cfg ? Number(cfg.fee_per_appt) : 30,
      note: cfg?.note ?? null,
    },
    summary: {
      deposits: appointments.length,
      inPipeline,
      served,
      stuck,
      unmatched: appointments.length - inPipeline,
    },
    appointments,
  });
}
