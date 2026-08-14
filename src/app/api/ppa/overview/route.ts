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
  showed: number; no_show_marked: number; excluded_count: number;
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

  const [sumRes, depRes, cfgRes, chgRes, refRes, sbRes] = await Promise.all([
    svc.from("ppa_billing_summary").select("*").in("owner_key", ownerKeys),
    svc.from("ppa_deposit_counts").select("*").in("biz_norm", bizNorms),
    svc.from("ppa_config").select("*").in("owner_key", ownerKeys),
    svc.from("ppa_charges").select("owner_key, appt_id, charged, excluded, amount").in("owner_key", ownerKeys),
    svc.from("deposit_refunds").select("business, email, contact_name").eq("status", "refunded"),
    svc.from("ppa_selfbooked").select("appt_id, owner_key").in("owner_key", ownerKeys),
  ]);

  // Executed refunds per business (normalized) — a refunded deposit is not
  // billable, so it's surfaced as its own bucket on the row.
  const refNorm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const refundsByBiz = new Map<string, number>();
  for (const r of (refRes.data ?? []) as Array<{ business: string | null }>) {
    const k = refNorm(String(r.business ?? ""));
    if (k) refundsByBiz.set(k, (refundsByBiz.get(k) ?? 0) + 1);
  }

  const sumBy = new Map<string, SummaryRow>();
  for (const r of (sumRes.data ?? []) as SummaryRow[]) sumBy.set(r.owner_key, r);

  const depBy = new Map<string, { deposits: number; deposit_total: number }>();
  for (const r of (depRes.data ?? []) as Array<{ biz_norm: string; deposits: number; deposit_total: number }>)
    depBy.set(r.biz_norm, { deposits: Number(r.deposits) || 0, deposit_total: Number(r.deposit_total) || 0 });

  const cfgBy = new Map<string, { is_ppa: boolean; fee_per_appt: number; note: string | null }>();
  for (const r of (cfgRes.data ?? []) as Array<{ owner_key: string; is_ppa: boolean; fee_per_appt: number; note: string | null }>)
    cfgBy.set(r.owner_key, { is_ppa: !!r.is_ppa, fee_per_appt: Number(r.fee_per_appt), note: r.note });

  type ChgRow = { owner_key: string; appt_id: string; charged: boolean; excluded: boolean | null; amount: number | null };
  const chgAmtBy = new Map<string, number>();
  const chgByApptId = new Map<string, ChgRow>();
  // Charged count comes from ppa_charges directly (not the deposit-based
  // summary view) so charged self-booked shows are counted too.
  const chgCountBy = new Map<string, number>();
  for (const r of (chgRes.data ?? []) as ChgRow[]) {
    chgByApptId.set(r.appt_id, r);
    if (!r.charged) continue;
    chgAmtBy.set(r.owner_key, (chgAmtBy.get(r.owner_key) ?? 0) + (Number(r.amount) || 0));
    chgCountBy.set(r.owner_key, (chgCountBy.get(r.owner_key) ?? 0) + 1);
  }

  // Self-booked shows still waiting on a charge decision (view applies the
  // Aug 1 cutoff; charged/voided ones drop out here).
  const sbReadyBy = new Map<string, number>();
  for (const r of (sbRes.data ?? []) as Array<{ appt_id: string; owner_key: string }>) {
    const ch = chgByApptId.get(r.appt_id);
    if (ch?.charged || ch?.excluded) continue;
    sbReadyBy.set(r.owner_key, (sbReadyBy.get(r.owner_key) ?? 0) + 1);
  }

  const clients = roster.map((c) => {
    const s = sumBy.get(c.ownerKey);
    const dep = depBy.get(c.bizNorm) ?? { deposits: 0, deposit_total: 0 };
    const cfg = cfgBy.get(c.ownerKey) ?? { is_ppa: false, fee_per_appt: 30, note: null };
    // The financing sheet's latest month is the source of truth for the fee;
    // the dashboard-entered fee only fills in when the notes don't state one.
    const fee = c.sheetFee ?? cfg.fee_per_appt;
    const selfBooked = sbReadyBy.get(c.ownerKey) ?? 0;
    // Ready = deposit-linked shows waiting + self-booked shows waiting; both
    // bill at the same fee, and the verify report's shows list matches this.
    const readyToCharge = (s?.ready_to_charge ?? 0) + selfBooked;
    const showed = s?.showed ?? 0;
    const noShowMarked = s?.no_show_marked ?? 0;
    const reviewed = showed + noShowMarked;
    return {
      ownerKey: c.ownerKey,
      ownerName: c.ownerName,
      business: c.business,
      status: c.status,
      version: c.version,
      // The roster only contains PPA-marked clients now, so everyone bills
      // per appointment — the old per-client toggle is meaningless.
      isPpa: true,
      fee,
      feeSource: c.sheetFee != null ? "sheet" : "dashboard",
      sheetNotes: c.sheetNotes,
      note: cfg.note,
      deposits: dep.deposits,
      depositTotal: dep.deposit_total,
      served: s?.served ?? 0,
      pastDue: s?.past_due ?? 0,
      upcoming: s?.upcoming ?? 0,
      noshow: s?.noshow ?? 0,
      noAppt: s?.no_appt ?? 0,
      selfBooked,
      readyToCharge,
      chargedCount: chgCountBy.get(c.ownerKey) ?? 0,
      chargedAmount: chgAmtBy.get(c.ownerKey) ?? 0,
      readyOwed: readyToCharge * fee,
      // Show rate = showed / (showed + marked no-show), from our review decisions.
      showed,
      noShowMarked,
      excludedCount: s?.excluded_count ?? 0,
      refundedCount: refundsByBiz.get(c.bizNorm) ?? 0,
      showRate: reviewed > 0 ? Math.round((showed / reviewed) * 100) : null,
    };
  });

  return NextResponse.json({ clients, missingFromMaster });
}
