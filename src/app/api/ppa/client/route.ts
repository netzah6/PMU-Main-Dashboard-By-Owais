import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth, getV3Roster, ingestAppointments } from "@/lib/ppa";

export const maxDuration = 120;

// Drill-down for one V3 client: every deposit (appointment) with its lead's
// current stage, scheduled appointment date, and a charge status
// (upcoming / past-due / served / no-show / no-appt) + charge state. Admin only.

type DepRow = {
  appt_id: string; business: string; contact_name: string | null; email: string | null;
  deposit_date: string | null; amount: string | null; status: string | null;
  notes: string | null; source: string | null;
};
type ChargeRow = {
  appt_id: string; charged: boolean; amount: number | null; note: string | null;
  charged_at: string | null; charged_by: string | null;
};
type BillingRow = {
  appt_id: string; stage_name: string | null; is_session_done: boolean; is_five_star: boolean;
  position: number | null; start_time: string | null; appt_status: string | null; charge_status: string;
};

export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const ownerKey = (req.nextUrl.searchParams.get("owner_key") ?? "").trim().toLowerCase();
  if (!ownerKey) return NextResponse.json({ error: "owner_key required" }, { status: 400 });

  const roster = await getV3Roster();
  const client = roster.find((c) => c.ownerKey === ownerKey);
  if (!client) return NextResponse.json({ error: "not a V3 client" }, { status: 404 });

  // Keep this client's appointments fresh (only its deposit leads — fast).
  await ingestAppointments([ownerKey]);

  const svc = createServiceClient();
  const [depRes, chgRes, billRes, cfgRes] = await Promise.all([
    svc.from("ppa_deposit_rows").select("*").eq("biz_norm", client.bizNorm),
    svc.from("ppa_charges").select("*").eq("owner_key", ownerKey),
    svc.from("ppa_deposit_billing").select("*").eq("owner_key", ownerKey),
    svc.from("ppa_config").select("*").eq("owner_key", ownerKey).maybeSingle(),
  ]);

  const chgBy = new Map<string, ChargeRow>();
  for (const r of (chgRes.data ?? []) as ChargeRow[]) chgBy.set(r.appt_id, r);
  const billBy = new Map<string, BillingRow>();
  for (const r of (billRes.data ?? []) as BillingRow[]) billBy.set(r.appt_id, r);

  const summary = { deposits: 0, served: 0, pastDue: 0, upcoming: 0, noshow: 0, noAppt: 0, readyToCharge: 0 };
  const appointments = ((depRes.data ?? []) as DepRow[]).map((d) => {
    const c = chgBy.get(d.appt_id);
    const b = billBy.get(d.appt_id);
    const chargeStatus = b?.charge_status ?? "no_appt";
    const charged = c?.charged ?? false;
    summary.deposits++;
    if (chargeStatus === "served") summary.served++;
    else if (chargeStatus === "past_due") summary.pastDue++;
    else if (chargeStatus === "upcoming") summary.upcoming++;
    else if (chargeStatus === "noshow") summary.noshow++;
    else summary.noAppt++;
    if (!charged && (chargeStatus === "served" || chargeStatus === "past_due")) summary.readyToCharge++;
    return {
      apptId: d.appt_id,
      contactName: d.contact_name,
      email: d.email,
      depositDate: d.deposit_date,
      amount: d.amount,
      status: d.status,
      notes: d.notes,
      source: d.source,
      currentStage: b?.stage_name ?? null,
      appointmentDate: b?.start_time ?? null,
      appointmentStatus: b?.appt_status ?? null,
      chargeStatus,
      charged,
      chargedAmount: c?.amount ?? null,
      chargedAt: c?.charged_at ?? null,
      chargedBy: c?.charged_by ?? null,
      chargeNote: c?.note ?? null,
    };
  });
  // Ready-to-charge first, then upcoming, then the rest; newest deposit within.
  const rank: Record<string, number> = { served: 0, past_due: 1, upcoming: 2, no_appt: 3, noshow: 4 };
  appointments.sort((a, b) => {
    const ca = a.charged ? 9 : (rank[a.chargeStatus] ?? 5);
    const cb = b.charged ? 9 : (rank[b.chargeStatus] ?? 5);
    if (ca !== cb) return ca - cb;
    return String(b.depositDate ?? "").localeCompare(String(a.depositDate ?? ""));
  });

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
    summary,
    appointments,
  });
}
