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

  const [sumRes, depRes, cfgRes, chgRes, refRes, sbRes, calRes] = await Promise.all([
    svc.from("ppa_billing_summary").select("*").in("owner_key", ownerKeys),
    svc.from("ppa_deposit_counts").select("*").in("biz_norm", bizNorms),
    svc.from("ppa_config").select("*, billing_exempt").in("owner_key", ownerKeys),
    svc.from("ppa_charges").select("owner_key, appt_id, charged, excluded, amount, square_payment_id").in("owner_key", ownerKeys),
    svc.from("deposit_refunds").select("business, email, contact_name, amount").eq("status", "refunded"),
    svc.from("ppa_selfbooked").select("appt_id, owner_key").in("owner_key", ownerKeys),
    svc.from("ppa_calendar_booked").select("appt_id, owner_key, start_time").in("owner_key", ownerKeys),
  ]);

  // Every deposit row (amount + date) for the profitability columns — paged
  // past Supabase's 1,000-row cap. Sheet dates arrive as DD/MM/YYYY, webhook
  // dates as ISO timestamps; parse both, skip the unparseable.
  type DepRowLite = { biz_norm: string; amount: string | null; deposit_date: string | null };
  const depRows: DepRowLite[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await svc.from("ppa_deposit_rows")
      .select("biz_norm, amount, deposit_date").in("biz_norm", bizNorms).range(from, from + 999);
    const page = (data ?? []) as DepRowLite[];
    depRows.push(...page);
    if (page.length < 1000) break;
  }

  // Executed refunds per business (normalized) — a refunded deposit is not
  // billable, so it's surfaced as its own bucket on the row.
  const refNorm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const refundsByBiz = new Map<string, number>();
  const refundUsdByBiz = new Map<string, number>();
  const parseUsd = (v: unknown) => Number(String(v ?? "").replace(/[^0-9.]/g, "")) || 0;
  for (const r of (refRes.data ?? []) as Array<{ business: string | null; amount: string | null }>) {
    const k = refNorm(String(r.business ?? ""));
    if (!k) continue;
    refundsByBiz.set(k, (refundsByBiz.get(k) ?? 0) + 1);
    refundUsdByBiz.set(k, (refundUsdByBiz.get(k) ?? 0) + parseUsd(r.amount));
  }

  // ── Profitability: deposits per month + lifetime value ─────────────────────
  // Sheet dates are DD/MM/YYYY, webhook dates ISO — parse both; a row with an
  // unparseable date still counts toward lifetime totals, just not toward the
  // monthly buckets.
  const parseDepositDate = (v: string | null): Date | null => {
    const s = String(v ?? "").trim();
    if (!s) return null;
    const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (dmy) {
      const d = new Date(Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1])));
      return isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  };
  const now = new Date();
  const thisMonthKey = now.getUTCFullYear() * 12 + now.getUTCMonth();
  type LtvAgg = { depUsd: number; monthCount: number; monthUsd: number; firstMonthKey: number | null };
  const ltvByBiz = new Map<string, LtvAgg>();
  for (const r of depRows) {
    const agg = ltvByBiz.get(r.biz_norm) ?? { depUsd: 0, monthCount: 0, monthUsd: 0, firstMonthKey: null };
    const usd = parseUsd(r.amount);
    agg.depUsd += usd;
    const d = parseDepositDate(r.deposit_date);
    if (d) {
      const mk = d.getUTCFullYear() * 12 + d.getUTCMonth();
      if (mk === thisMonthKey) { agg.monthCount++; agg.monthUsd += usd; }
      if (agg.firstMonthKey == null || mk < agg.firstMonthKey) agg.firstMonthKey = mk;
    }
    ltvByBiz.set(r.biz_norm, agg);
  }

  const sumBy = new Map<string, SummaryRow>();
  for (const r of (sumRes.data ?? []) as SummaryRow[]) sumBy.set(r.owner_key, r);

  const depBy = new Map<string, { deposits: number; deposit_total: number }>();
  for (const r of (depRes.data ?? []) as Array<{ biz_norm: string; deposits: number; deposit_total: number }>)
    depBy.set(r.biz_norm, { deposits: Number(r.deposits) || 0, deposit_total: Number(r.deposit_total) || 0 });

  const cfgBy = new Map<string, { is_ppa: boolean; fee_per_appt: number; note: string | null; billing_exempt: boolean }>();
  for (const r of (cfgRes.data ?? []) as Array<{ owner_key: string; is_ppa: boolean; fee_per_appt: number; note: string | null; billing_exempt?: boolean }>)
    cfgBy.set(r.owner_key, { is_ppa: !!r.is_ppa, fee_per_appt: Number(r.fee_per_appt), note: r.note, billing_exempt: !!r.billing_exempt });

  type ChgRow = { owner_key: string; appt_id: string; charged: boolean; excluded: boolean | null; amount: number | null; square_payment_id: string | null };
  const chgAmtBy = new Map<string, number>();
  const chgByApptId = new Map<string, ChgRow>();
  // Charged count comes from ppa_charges directly (not the deposit-based
  // summary view) so charged self-booked shows are counted too.
  const chgCountBy = new Map<string, number>();
  // Chat-billed rows without a Square payment id are DECIDED but not yet
  // COLLECTED — they count as ready-to-charge, not as charged.
  const chatReadyBy = new Map<string, number>();
  for (const r of (chgRes.data ?? []) as ChgRow[]) {
    chgByApptId.set(r.appt_id, r);
    if (!r.charged) continue;
    if (r.appt_id.startsWith("chat:") && !r.square_payment_id && !r.excluded) {
      chatReadyBy.set(r.owner_key, (chatReadyBy.get(r.owner_key) ?? 0) + 1);
      continue;
    }
    chgAmtBy.set(r.owner_key, (chgAmtBy.get(r.owner_key) ?? 0) + (Number(r.amount) || 0));
    chgCountBy.set(r.owner_key, (chgCountBy.get(r.owner_key) ?? 0) + 1);
  }

  // "Their end" shows (both views apply the Aug 1 cutoff): done-stage leads
  // with no deposit (ppa_selfbooked) + calendar appointments for no-deposit
  // leads (ppa_calendar_booked, past only — future ones count as upcoming).
  // The views are mutually exclusive, so totals never double-count a lead.
  const sbTotalBy = new Map<string, number>();
  const sbReadyBy = new Map<string, number>();
  const calUpcomingBy = new Map<string, number>();
  for (const r of (sbRes.data ?? []) as Array<{ appt_id: string; owner_key: string }>) {
    sbTotalBy.set(r.owner_key, (sbTotalBy.get(r.owner_key) ?? 0) + 1);
    const ch = chgByApptId.get(r.appt_id);
    if (ch?.charged || ch?.excluded) continue;
    sbReadyBy.set(r.owner_key, (sbReadyBy.get(r.owner_key) ?? 0) + 1);
  }
  const nowMs = Date.now();
  for (const r of (calRes.data ?? []) as Array<{ appt_id: string; owner_key: string; start_time: string | null }>) {
    const past = r.start_time != null && new Date(r.start_time).getTime() < nowMs;
    if (!past) { calUpcomingBy.set(r.owner_key, (calUpcomingBy.get(r.owner_key) ?? 0) + 1); continue; }
    sbTotalBy.set(r.owner_key, (sbTotalBy.get(r.owner_key) ?? 0) + 1);
    const ch = chgByApptId.get(r.appt_id);
    if (ch?.charged || ch?.excluded) continue;
    sbReadyBy.set(r.owner_key, (sbReadyBy.get(r.owner_key) ?? 0) + 1);
  }

  const clients = roster.map((c) => {
    const s = sumBy.get(c.ownerKey);
    const dep = depBy.get(c.bizNorm) ?? { deposits: 0, deposit_total: 0 };
    const cfg = cfgBy.get(c.ownerKey) ?? { is_ppa: false, fee_per_appt: 30, note: null, billing_exempt: false };
    // The financing sheet's latest month is the source of truth for the fee;
    // the dashboard-entered fee only fills in when the notes don't state one.
    const fee = c.sheetFee ?? cfg.fee_per_appt;
    const selfBookedReady = sbReadyBy.get(c.ownerKey) ?? 0;
    // Ready = deposit-linked shows waiting + self-booked shows waiting; both
    // bill at the same fee, and the verify report's shows list matches this.
    // Deposit-only clients owe no service fee — nothing is ever "ready".
    const readyToCharge = cfg.billing_exempt ? 0 : (s?.ready_to_charge ?? 0) + selfBookedReady + (chatReadyBy.get(c.ownerKey) ?? 0);
    const showed = s?.showed ?? 0;
    const noShowMarked = s?.no_show_marked ?? 0;
    const reviewed = showed + noShowMarked;
    // ── Profitability ────────────────────────────────────────────────────────
    // LTV = every service fee collected + every deposit taken − refunds given
    // back. Average per month spreads that over the months since the client's
    // first deposit (minimum 1, current month counts as a full month).
    const ltvAgg = ltvByBiz.get(c.bizNorm) ?? { depUsd: 0, monthCount: 0, monthUsd: 0, firstMonthKey: null };
    const feesLtv = chgAmtBy.get(c.ownerKey) ?? 0;
    const refundUsd = refundUsdByBiz.get(c.bizNorm) ?? 0;
    const ltv = feesLtv + ltvAgg.depUsd - refundUsd;
    const monthsActive = ltvAgg.firstMonthKey != null ? Math.max(1, thisMonthKey - ltvAgg.firstMonthKey + 1) : 1;
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
      upcoming: (s?.upcoming ?? 0) + (calUpcomingBy.get(c.ownerKey) ?? 0),
      noshow: s?.noshow ?? 0,
      noAppt: s?.no_appt ?? 0,
      selfBooked: sbTotalBy.get(c.ownerKey) ?? 0,
      selfBookedReady,
      readyToCharge,
      chargedCount: chgCountBy.get(c.ownerKey) ?? 0,
      chargedAmount: chgAmtBy.get(c.ownerKey) ?? 0,
      readyOwed: readyToCharge * fee,
      billingExempt: cfg.billing_exempt,
      // Show rate = showed / (showed + marked no-show), from our review decisions.
      showed,
      noShowMarked,
      excludedCount: s?.excluded_count ?? 0,
      refundedCount: refundsByBiz.get(c.bizNorm) ?? 0,
      showRate: reviewed > 0 ? Math.round((showed / reviewed) * 100) : null,
      depositsThisMonth: ltvAgg.monthCount,
      depositsThisMonthUsd: ltvAgg.monthUsd,
      ltv: Math.round(ltv * 100) / 100,
      ltvFees: feesLtv,
      ltvDeposits: ltvAgg.depUsd,
      ltvRefunded: refundUsd,
      monthsActive,
      avgPerMonth: Math.round((ltv / monthsActive) * 100) / 100,
    };
  });

  return NextResponse.json({ clients, missingFromMaster });
}
