import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth, getV3Roster } from "@/lib/ppa";

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
  excluded: boolean | null; exclude_reason: string | null;
  excluded_at: string | null; excluded_by: string | null;
  square_payment_id?: string | null;
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

  const svc = createServiceClient();
  const [depRes, chgRes, billRes, cfgRes, refRes, sbRes, calRes] = await Promise.all([
    svc.from("ppa_deposit_rows").select("*").eq("biz_norm", client.bizNorm),
    svc.from("ppa_charges").select("*").eq("owner_key", ownerKey),
    svc.from("ppa_deposit_billing").select("*").eq("owner_key", ownerKey),
    svc.from("ppa_config").select("*").eq("owner_key", ownerKey).maybeSingle(),
    svc.from("deposit_refunds").select("business, contact_name, email, decided_at").eq("status", "refunded"),
    svc.from("ppa_selfbooked").select("appt_id, contact_name, email, stage_name, done_at").eq("owner_key", ownerKey),
    svc.from("ppa_calendar_booked").select("appt_id, contact_name, email, status, title, start_time").eq("owner_key", ownerKey),
  ]);

  // Executed refunds for THIS business, matched by email (fallback: name).
  const bizNorm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const refunds = ((refRes.data ?? []) as Array<{ business: string | null; contact_name: string | null; email: string | null; decided_at: string | null }>)
    .filter((r) => bizNorm(String(r.business ?? "")) === client.bizNorm);
  const refundByEmail = new Map<string, string | null>();
  const refundByName = new Map<string, string | null>();
  for (const r of refunds) {
    if (r.email) refundByEmail.set(r.email.toLowerCase().trim(), r.decided_at);
    if (r.contact_name) refundByName.set(r.contact_name.toLowerCase().trim(), r.decided_at);
  }

  const chgBy = new Map<string, ChargeRow>();
  for (const r of (chgRes.data ?? []) as ChargeRow[]) chgBy.set(r.appt_id, r);
  const billBy = new Map<string, BillingRow>();
  for (const r of (billRes.data ?? []) as BillingRow[]) billBy.set(r.appt_id, r);

  // showedCount / noShowCount are the review decisions that measure show rate:
  // a charged appointment = the client showed; an exclude with reason "no_show"
  // = they didn't. Other exclude reasons void the row without affecting the rate.
  const summary = { deposits: 0, served: 0, pastDue: 0, upcoming: 0, noshow: 0, noAppt: 0, selfBooked: 0, readyToCharge: 0, excluded: 0, refunded: 0, showed: 0, noShowMarked: 0, showRate: null as number | null };
  const appointments = ((depRes.data ?? []) as DepRow[]).map((d) => {
    const c = chgBy.get(d.appt_id);
    const b = billBy.get(d.appt_id);
    const chargeStatus = b?.charge_status ?? "no_appt";
    const charged = c?.charged ?? false;
    const excluded = c?.excluded ?? false;
    const excludeReason = c?.exclude_reason ?? null;
    // A refunded deposit is never billable — the client gave the money back.
    const refundedAt = (d.email && refundByEmail.get(d.email.toLowerCase().trim())) ||
      (d.contact_name && refundByName.get(d.contact_name.toLowerCase().trim())) || null;
    const refunded = refundedAt !== null || refundedAt === "";
    summary.deposits++;
    if (chargeStatus === "served") summary.served++;
    else if (chargeStatus === "past_due") summary.pastDue++;
    else if (chargeStatus === "upcoming") summary.upcoming++;
    else if (chargeStatus === "noshow") summary.noshow++;
    else summary.noAppt++;
    if (excluded) summary.excluded++;
    if (refunded) summary.refunded++;
    if (charged) summary.showed++;
    else if (excluded && excludeReason === "no_show") summary.noShowMarked++;
    // Ready = a past appointment we haven't reviewed yet (not charged, not excluded).
    if (!charged && !excluded && !refunded && (chargeStatus === "served" || chargeStatus === "past_due")) summary.readyToCharge++;
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
      excluded,
      excludeReason,
      refunded,
      refundedAt: refundedAt || null,
      chargedAmount: c?.amount ?? null,
      chargedAt: c?.charged_at ?? null,
      chargedBy: c?.charged_by ?? null,
      chargeNote: c?.note ?? null,
    };
  });
  // Self-booked shows: leads we sent that the artist booked on her end — no
  // deposit, but the show fee still applies. Same charge/void controls; the
  // view's Aug 1 cutoff keeps retainer-era history out.
  for (const s of (sbRes.data ?? []) as Array<{ appt_id: string; contact_name: string | null; email: string | null; stage_name: string | null; done_at: string | null }>) {
    const c = chgBy.get(s.appt_id);
    const charged = c?.charged ?? false;
    const excluded = c?.excluded ?? false;
    summary.selfBooked++;
    if (excluded) summary.excluded++;
    if (charged) summary.showed++;
    else if (excluded && c?.exclude_reason === "no_show") summary.noShowMarked++;
    if (!charged && !excluded) summary.readyToCharge++;
    appointments.push({
      apptId: s.appt_id,
      contactName: s.contact_name,
      email: s.email,
      depositDate: null,
      amount: null,
      status: null,
      notes: null,
      source: "self-booked",
      currentStage: s.stage_name,
      appointmentDate: s.done_at,
      appointmentStatus: null,
      chargeStatus: "self_booked",
      charged,
      excluded,
      excludeReason: c?.exclude_reason ?? null,
      refunded: false,
      refundedAt: null,
      chargedAmount: c?.amount ?? null,
      chargedAt: c?.charged_at ?? null,
      chargedBy: c?.charged_by ?? null,
      chargeNote: c?.note ?? null,
    });
  }
  // Chat-billed bookings ("Bill $X" on the Booked-in-chat panel). A row with
  // no Square payment id yet is decided-but-uncollected: it shows here as
  // ready so the client (e.g. Zuleika, 2026-08-23) doesn't vanish after the
  // flag is cleared; once the charge run collects it, it flips to charged.
  for (const c of (chgRes.data ?? []) as ChargeRow[]) {
    if (!c.appt_id.startsWith("chat:")) continue;
    if (!c.charged && !c.excluded) continue;
    const collected = !!c.square_payment_id;
    const name = (c.note ?? "").split("— ").pop()?.trim() || null;
    summary.selfBooked++;
    if (c.excluded) summary.excluded++;
    else if (collected) summary.showed++;
    else summary.readyToCharge++;
    appointments.push({
      apptId: c.appt_id,
      contactName: name,
      email: null,
      depositDate: null,
      amount: null,
      status: null,
      notes: null,
      source: "chat",
      currentStage: null,
      appointmentDate: c.charged_at,
      appointmentStatus: null,
      chargeStatus: "chat_booked",
      charged: collected,
      excluded: !!c.excluded,
      excludeReason: c.exclude_reason,
      refunded: false,
      refundedAt: null,
      chargedAmount: c.amount,
      chargedAt: c.charged_at,
      chargedBy: c.charged_by,
      chargeNote: c.note,
    });
  }

  // Calendar-booked shows: the artist put a NO-DEPOSIT lead on her GHL
  // calendar. Past ones bill by default (same policy as past-due deposits);
  // future ones are upcoming info. The view excludes deposit and done-stage
  // leads, so nothing is ever double-billed across paths.
  const nowMs = Date.now();
  for (const s of (calRes.data ?? []) as Array<{ appt_id: string; contact_name: string | null; email: string | null; status: string | null; title: string | null; start_time: string | null }>) {
    const c = chgBy.get(s.appt_id);
    const charged = c?.charged ?? false;
    const excluded = c?.excluded ?? false;
    const past = s.start_time != null && new Date(s.start_time).getTime() < nowMs;
    summary.selfBooked++;
    if (!past) summary.upcoming++;
    if (excluded) summary.excluded++;
    if (charged) summary.showed++;
    else if (excluded && c?.exclude_reason === "no_show") summary.noShowMarked++;
    if (past && !charged && !excluded) summary.readyToCharge++;
    appointments.push({
      apptId: s.appt_id,
      contactName: s.contact_name,
      email: s.email,
      depositDate: null,
      amount: null,
      status: null,
      notes: s.title,
      source: "calendar",
      currentStage: null,
      appointmentDate: s.start_time,
      appointmentStatus: s.status,
      chargeStatus: past ? "calendar_booked" : "upcoming",
      charged,
      excluded,
      excludeReason: c?.exclude_reason ?? null,
      refunded: false,
      refundedAt: null,
      chargedAmount: c?.amount ?? null,
      chargedAt: c?.charged_at ?? null,
      chargedBy: c?.charged_by ?? null,
      chargeNote: c?.note ?? null,
    });
  }
  const reviewed = summary.showed + summary.noShowMarked;
  summary.showRate = reviewed > 0 ? Math.round((summary.showed / reviewed) * 100) : null;
  // Chronological by appointment date (user request: "organize by the Appt
  // date column") — oldest first so past sessions read top-down into future
  // bookings; rows with no appointment sink to the bottom (newest deposit
  // first among those).
  const apptTime = (a: (typeof appointments)[number]) => {
    const t = a.appointmentDate ? new Date(a.appointmentDate).getTime() : NaN;
    return isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  appointments.sort((a, b) => {
    const ta = apptTime(a), tb = apptTime(b);
    if (ta !== tb) return ta - tb;
    return String(b.depositDate ?? "").localeCompare(String(a.depositDate ?? ""));
  });

  const cfg = (cfgRes.data ?? null) as { is_ppa: boolean; fee_per_appt: number; note: string | null } | null;

  // ── Payment history: every charge that went through, grouped per payment ──
  // One Square payment covers several shows (same square_payment_id); manual
  // marks batch by minute + marker. Receipt URLs derive from the payment id.
  const payGroups = new Map<string, {
    paymentId: string | null; chargedAt: string | null; chargedBy: string | null;
    shows: number; total: number; manual: boolean;
  }>();
  for (const r of (chgRes.data ?? []) as ChargeRow[]) {
    if (!r.charged) continue;
    const key = r.square_payment_id ?? `manual:${(r.charged_at ?? "").slice(0, 16)}:${r.charged_by ?? ""}`;
    const g = payGroups.get(key) ?? {
      paymentId: r.square_payment_id ?? null, chargedAt: r.charged_at, chargedBy: r.charged_by,
      shows: 0, total: 0, manual: !r.square_payment_id,
    };
    g.shows++;
    g.total += Number(r.amount) || 0;
    if ((r.charged_at ?? "") > (g.chargedAt ?? "")) g.chargedAt = r.charged_at;
    payGroups.set(key, g);
  }
  const payments = [...payGroups.values()]
    .sort((a, b) => String(b.chargedAt ?? "").localeCompare(String(a.chargedAt ?? "")))
    .map((g) => ({
      ...g,
      receiptUrl: g.paymentId ? `https://squareup.com/receipt/preview/${g.paymentId}` : null,
    }));

  return NextResponse.json({
    payments,
    client: {
      ownerKey: client.ownerKey,
      ownerName: client.ownerName,
      business: client.business,
      status: client.status,
      isPpa: cfg?.is_ppa ?? false,
      // Sheet fee first — the financing sheet's latest month is authoritative.
      fee: client.sheetFee ?? (cfg ? Number(cfg.fee_per_appt) : 30),
      feeSource: client.sheetFee != null ? "sheet" : "dashboard",
      sheetNotes: client.sheetNotes,
      note: cfg?.note ?? null,
    },
    summary,
    appointments,
  });
}
