"use client";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Search, ChevronDown, ChevronRight, Check, DollarSign, CalendarClock, Ban, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { CardCell, StatusCell, ActionsCell, PaymentDetails, PayMsg, showSplit, type PayMsgData, type VReport, type VRow } from "@/components/billing/PaymentSection";

// ── Types (mirror /api/ppa/*) ────────────────────────────────────────────────
interface ClientRow {
  ownerKey: string; ownerName: string; business: string; status: string; version: string;
  isPpa: boolean; fee: number; feeSource?: "sheet" | "dashboard"; sheetNotes?: string | null; note: string | null;
  deposits: number; depositTotal: number;
  served: number; pastDue: number; upcoming: number; noshow: number; noAppt: number; selfBooked?: number; selfBookedReady?: number;
  readyToCharge: number; chargedCount: number; chargedAmount: number; readyOwed: number; billingExempt?: boolean;
  showed: number; noShowMarked: number; excludedCount: number; refundedCount?: number; showRate: number | null;
  depositsThisMonth?: number; depositsThisMonthUsd?: number;
  ltv?: number; ltvFees?: number; ltvDeposits?: number; ltvRefunded?: number;
  monthsActive?: number; avgPerMonth?: number;
  last30?: number; last30Fees?: number; last30Deposits?: number; last30DepositCount?: number; last30Refunded?: number;
}
interface Appt {
  apptId: string; contactName: string | null; email: string | null; depositDate: string | null;
  amount: string | null; status: string | null; notes: string | null; source: string | null;
  currentStage: string | null; appointmentDate: string | null; appointmentStatus: string | null;
  chargeStatus: string; charged: boolean; chargedAmount: number | null; chargedAt: string | null;
  chargedBy: string | null; chargeNote: string | null;
  excluded: boolean; excludeReason: string | null;
  refunded?: boolean; refundedAt?: string | null;
}
interface PaymentGroup {
  paymentId: string | null; chargedAt: string | null; chargedBy: string | null;
  shows: number; total: number; manual: boolean; receiptUrl: string | null;
}
interface Drill {
  payments?: PaymentGroup[];
  client: { ownerKey: string; ownerName: string; business: string; isPpa: boolean; fee: number; note: string | null };
  summary: { deposits: number; served: number; pastDue: number; upcoming: number; noshow: number; noAppt: number; selfBooked?: number; readyToCharge: number; excluded: number; refunded?: number; showed: number; noShowMarked: number; showRate: number | null };
  appointments: Appt[];
}

// Reasons an appointment is voided (not billed, not pending). "no_show" is the
// only one that counts against show rate; the rest are neutral voids.
const EXCLUDE_REASONS: { key: string; label: string }[] = [
  { key: "no_show", label: "No-show" },
  { key: "cancelled", label: "Cancelled" },
  { key: "refunded", label: "Refunded" },
  { key: "test", label: "Test" },
  { key: "not_a_fit", label: "Not a fit" },
  { key: "other", label: "Other" },
];
const reasonLabel = (k: string | null) => EXCLUDE_REASONS.find((r) => r.key === k)?.label ?? "Excluded";

const CS: Record<string, { label: string; cls: string }> = {
  served:   { label: "Served",       cls: "bg-[#e6f7ee] text-[#15803d] border-[#c7edd4]" },
  past_due: { label: "Past due",     cls: "bg-[#fff7ec] text-[#d97706] border-[#fcd9a8]" },
  upcoming: { label: "Upcoming",     cls: "bg-[#eef4ff] text-[#3b6fd4] border-[#c9dbfb]" },
  noshow:   { label: "No-show",      cls: "bg-[#fde8ee] text-[#e11d48] border-[#f5c2cf]" },
  no_appt:  { label: "No appt",      cls: "bg-[#f1f5f9] text-[#64748b] border-[#e2e8f0]" },
  // Booked on the artist's end (no deposit through us) — still our lead, so
  // the show fee applies. Billable since Aug 1, 2026. "Self-booked" = she
  // marked the lead done in the pipeline; "Calendar" = the appointment sits on
  // her GHL calendar and its date has passed.
  self_booked: { label: "Self-booked", cls: "bg-[#f3e8ff] text-[#7c3aed] border-[#ddd6fe]" },
  calendar_booked: { label: "Calendar", cls: "bg-[#f3e8ff] text-[#7c3aed] border-[#ddd6fe]" },
  // Billed from the Booked-in-chat panel; collected by the next charge run.
  chat_booked: { label: "Chat", cls: "bg-[#f3e8ff] text-[#7c3aed] border-[#ddd6fe]" },
};
const isReady = (a: Appt) => !a.charged && !a.excluded && !a.refunded &&
  (a.chargeStatus === "served" || a.chargeStatus === "past_due" || a.chargeStatus === "self_booked" || a.chargeStatus === "calendar_booked" || a.chargeStatus === "chat_booked");

function money(n: number): string {
  return "$" + (n || 0).toLocaleString(undefined, { minimumFractionDigits: n % 1 ? 2 : 0 });
}
function fmtDate(d: string | null): string {
  if (!d) return "—";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? d : dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// ── Appointment tracker (drill-down) ─────────────────────────────────────────
function AppointmentList({ client, onCharged }: { client: ClientRow; onCharged: () => void }) {
  const [drill, setDrill] = useState<Drill | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [menuFor, setMenuFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/ppa/client?owner_key=${encodeURIComponent(client.ownerKey)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setDrill(json as Drill);
    } catch (e) { setError(`${e}`.replace("Error: ", "")); }
    finally { setLoading(false); }
  }, [client.ownerKey]);
  useEffect(() => { load(); }, [load]);

  const toggleCharge = async (a: Appt, charged: boolean) => {
    if (!drill) return;
    setBusy((b) => new Set(b).add(a.apptId));
    setDrill({ ...drill, appointments: drill.appointments.map((x) => x.apptId === a.apptId ? { ...x, charged, chargedAmount: charged ? client.fee : null } : x) });
    try {
      const res = await fetch("/api/ppa/charge", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appt_id: a.apptId, owner_key: client.ownerKey, charged, amount: charged ? client.fee : null }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "save failed");
      onCharged();
    } catch (e) {
      setError(`${e}`.replace("Error: ", "")); await load();
    } finally {
      setBusy((b) => { const n = new Set(b); n.delete(a.apptId); return n; });
    }
  };

  const chargeAllReady = async () => {
    if (!drill) return;
    for (const a of drill.appointments.filter(isReady)) await toggleCharge(a, true);
  };

  // Void an appointment (or restore it). Excluding clears any charge server-side.
  const setExclude = async (a: Appt, excluded: boolean, reason?: string) => {
    if (!drill) return;
    setMenuFor(null);
    setBusy((b) => new Set(b).add(a.apptId));
    setDrill({ ...drill, appointments: drill.appointments.map((x) => x.apptId === a.apptId
      ? { ...x, excluded, excludeReason: excluded ? (reason ?? "other") : null, charged: excluded ? false : x.charged } : x) });
    try {
      const res = await fetch("/api/ppa/charge", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appt_id: a.apptId, owner_key: client.ownerKey, excluded, exclude_reason: reason }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "save failed");
      onCharged();
    } catch (e) {
      setError(`${e}`.replace("Error: ", "")); await load();
    } finally {
      setBusy((b) => { const n = new Set(b); n.delete(a.apptId); return n; });
    }
  };

  if (loading) return <div className="flex items-center gap-2 text-xs text-[#697a91] py-6 justify-center"><Loader2 size={13} className="animate-spin" /> Loading appointments…</div>;
  if (error) return <div className="text-xs text-[#e11d48] py-4 text-center">{error}</div>;
  if (!drill) return null;

  const s = drill.summary;
  const readyCount = drill.appointments.filter(isReady).length;

  return (
    <div className="space-y-3 pt-1">
      {/* Show rate — from our review decisions (charged = showed, excluded no-show = didn't) */}
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="px-2 py-0.5 rounded-md font-bold border bg-[#eef7ff] text-[#1d4ed8] border-[#c9dbfb]">
          Show rate: {s.showRate == null ? "—" : `${s.showRate}%`}
          <span className="font-normal text-[#64748b]"> ({s.showed} showed / {s.noShowMarked} no-show)</span>
        </span>
        {s.excluded > 0 && <Pill label="Excluded" value={s.excluded} tone="gray" />}
        {(s.refunded ?? 0) > 0 && <Pill label="Refunded" value={s.refunded!} tone="amber" />}
      </div>
      {/* Deposit-linked snapshot */}
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="text-[#8595a8]">These deposits:</span>
        <Pill label="Served" value={s.served} tone="green" />
        <Pill label="Past due" value={s.pastDue} tone={s.pastDue > 0 ? "amber" : "gray"} />
        <Pill label="Upcoming" value={s.upcoming} tone="gray" />
        {(s.selfBooked ?? 0) > 0 && <Pill label="Self-booked (no deposit)" value={s.selfBooked!} tone="amber" />}
        {s.noshow > 0 && <Pill label="No-show" value={s.noshow} tone="gray" />}
        {s.noAppt > 0 && <Pill label="No appt booked" value={s.noAppt} tone="gray" />}
      </div>

      {/* Every charge that actually went through — the keep-track trail the
          user asked for: date, amount, shows covered, who ran it, receipt. */}
      {(drill.payments?.length ?? 0) > 0 && (
        <div className="rounded-lg border border-[#c7edd4] bg-[#f4fbf7] px-2.5 py-2">
          <div className="text-[10px] font-bold uppercase tracking-wider text-[#15803d] mb-1">✅ Charged &amp; went through</div>
          <div className="space-y-0.5">
            {drill.payments!.map((p, i) => (
              <div key={i} className="flex items-center gap-2 text-[11px] text-[#1f3559] flex-wrap">
                <span className="font-semibold text-[#15803d]">{money(p.total)}</span>
                <span className="text-[#697a91]">{p.shows} show{p.shows === 1 ? "" : "s"}</span>
                <span className="text-[#8595a8]">{p.chargedAt ? new Date(p.chargedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—"}</span>
                {p.chargedBy && <span className="text-[#8595a8]">by {p.chargedBy}</span>}
                {p.manual ? (
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-[#f1f5f9] text-[#64748b] border border-[#e2e8f0]" title="Recorded in the dashboard as collected outside it (e.g. charged directly in Square)">recorded manually</span>
                ) : (
                  <a href={p.receiptUrl!} target="_blank" rel="noreferrer"
                    className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-[#e6f7ee] text-[#15803d] border border-[#c7edd4] hover:bg-[#d9f2e4]"
                    title={`Square payment ${p.paymentId}`}>Square receipt ↗</a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-[#697a91]">{drill.appointments.length} deposit{drill.appointments.length === 1 ? "" : "s"} · <strong className="text-[#0e8f88]">{readyCount} to review</strong></span>
        {readyCount > 0 && (
          <button onClick={chargeAllReady}
            className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-[#e6f7f5] hover:bg-[#d6f0ed] text-[#0e8f88] border border-[#a7e3df]">
            <Check size={11} /> Mark all charged manually ({money(readyCount * client.fee)})
          </button>
        )}
      </div>

      {drill.appointments.length === 0 ? (
        <div className="text-xs text-[#8595a8] py-4 text-center border border-dashed border-[#e4ebf2] rounded-lg">
          No deposits found for this client{client.business ? ` (matched by business name "${client.business}")` : ""}.
        </div>
      ) : (
        <div className="rounded-lg border border-[#e4ebf2] overflow-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-[#e4ebf2] bg-[#f8fafc]">
                {["Contact", "Deposit", "Appt date", "Stage", "Status", "Bill / Void"].map((h) => (
                  <th key={h} className="px-2.5 py-1 text-left text-[10px] font-bold uppercase tracking-wider text-[#697a91] whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {drill.appointments.map((a, i) => {
                const ready = isReady(a);
                const cs = CS[a.chargeStatus] ?? CS.no_appt;
                const b = busy.has(a.apptId);
                return (
                  <tr key={a.apptId} className={cn("border-b border-[#eef3f8]",
                    a.excluded || a.refunded ? "bg-[#f6f7f9] text-[#94a3b8]" : a.charged ? "bg-[#f2fbf9]" : ready ? "bg-[#fffdf5]" : i % 2 ? "bg-[#fafcfe]" : "bg-white")}>
                    <td className="px-2.5 py-1.5">
                      <div className={cn("font-medium", a.excluded ? "text-[#94a3b8] line-through" : "text-[#1f3559]")}>{a.contactName || "—"}</div>
                      {a.email && <div className="text-[10px] text-[#8595a8]">{a.email}</div>}
                    </td>
                    <td className="px-2.5 py-1.5 whitespace-nowrap">
                      <span className={cn("font-semibold", a.excluded ? "text-[#94a3b8]" : "text-[#0e8f88]")}>{a.amount ? (a.amount.startsWith("$") ? a.amount : "$" + a.amount) : "—"}</span>
                      <div className="text-[10px] text-[#a6b3c4]">{fmtDate(a.depositDate)}</div>
                    </td>
                    {/* The date is the lead's LATEST appointment. A served
                        lead with a FUTURE date means: the session already
                        happened (stage = Session Done) and this is her next
                        booking — usually the touch-up. Label it so a future
                        date next to "Served" doesn't read as a bug. */}
                    <td className="px-2.5 py-1.5 text-[#697a91] whitespace-nowrap">
                      {fmtDate(a.appointmentDate)}
                      {a.chargeStatus === "served" && a.appointmentDate && new Date(a.appointmentDate).getTime() > Date.now() && (
                        <span className="ml-1 px-1 py-0.5 rounded text-[9px] font-semibold bg-[#eef4ff] text-[#3b6fd4] border border-[#c9dbfb]"
                          title='"Served" comes from the Session Done stage — the billed session already happened on an earlier appointment. This future date is the lead&apos;s NEXT booking (usually the touch-up).'>
                          next appt
                        </span>
                      )}
                    </td>
                    <td className="px-2.5 py-1.5 whitespace-nowrap">
                      {a.currentStage ? <span className="text-[#697a91]">{a.currentStage}</span> : <span className="text-[10px] text-[#b9c3d0]">no lead match</span>}
                    </td>
                    <td className="px-2.5 py-1.5">
                      <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-semibold border whitespace-nowrap", cs.cls)}>{cs.label}</span>
                    </td>
                    <td className="px-2.5 py-1.5">
                      {a.excluded ? (
                        <div className="flex items-center gap-1.5">
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold border bg-[#f1f5f9] text-[#64748b] border-[#e2e8f0] whitespace-nowrap">Excluded · {reasonLabel(a.excludeReason)}</span>
                          <button onClick={() => setExclude(a, false)} disabled={b} title="Restore" className="text-[#94a3b8] hover:text-[#0e8f88]">
                            {b ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={12} />}
                          </button>
                        </div>
                      ) : (
                        a.refunded && !a.charged ? (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold border bg-[#fff1f2] text-[#be123c] border-[#fecdd3] whitespace-nowrap">↩ Refunded — not billable</span>
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <button onClick={() => toggleCharge(a, !a.charged)} disabled={b}
                            title="Record this show as already collected — e.g. you charged her directly in Square. Marks the fee charged WITHOUT creating a new Square payment (the Charge button on the row is what moves money)."
                            className={cn("flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-semibold border transition-colors",
                              a.charged ? "bg-[#e6f7ee] text-[#15803d] border-[#86efac]"
                                : ready ? "bg-white text-[#0e8f88] border-[#a7e3df] hover:bg-[#e6f7f5]"
                                : "bg-white text-[#697a91] border-[#e4ebf2] hover:border-[#15B7AE] hover:text-[#0e8f88]")}>
                            {b ? <Loader2 size={11} className="animate-spin" /> : a.charged ? <Check size={11} /> : <DollarSign size={11} />}
                            {a.charged ? `Charged ${a.chargedAmount != null ? money(a.chargedAmount) : ""}` : "Charged manually"}
                          </button>
                          {!a.charged && (
                            <div className="relative">
                              <button onClick={() => setMenuFor(menuFor === a.apptId ? null : a.apptId)} disabled={b}
                                title="Don't charge" className="flex items-center gap-1 px-1.5 py-1 rounded-lg text-[11px] font-semibold border bg-white text-[#94a3b8] border-[#e4ebf2] hover:border-[#e11d48] hover:text-[#e11d48]">
                                <Ban size={11} /> Void
                              </button>
                              {menuFor === a.apptId && (
                                <div className="absolute right-0 z-30 mt-1 w-32 rounded-lg border border-[#e4ebf2] bg-white py-1" style={{ boxShadow: "0 8px 20px -6px rgba(0,0,0,0.25)" }}>
                                  {EXCLUDE_REASONS.map((r) => (
                                    <button key={r.key} onClick={() => setExclude(a, true, r.key)}
                                      className="block w-full text-left px-3 py-1.5 text-[11px] text-[#34568a] hover:bg-[#f1f5f9]">{r.label}</button>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                      {a.charged && a.chargedBy && <div className="text-[9px] text-[#a6b3c4] mt-0.5">by {a.chargedBy}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Pill({ label, value, tone }: { label: string; value: number | string; tone: "green" | "amber" | "gray" }) {
  const c = tone === "green" ? "bg-[#e6f7ee] text-[#15803d] border-[#c7edd4]"
    : tone === "amber" ? "bg-[#fff7ec] text-[#d97706] border-[#fcd9a8]"
    : "bg-[#f1f5f9] text-[#64748b] border-[#e2e8f0]";
  return <span className={cn("px-1.5 py-0.5 rounded border font-semibold", c)}>{label}: {value}</span>;
}

// ── Client table row ─────────────────────────────────────────────────────────
// The client list is a real table: every number lives in a fixed column, so
// rows align and can be compared down the page. NumCell keeps digits tabular.

const COLS = 15; // for colSpan on the message/drill-down rows

function NumCell({ value, sub, tone, title }: { value: string | number; sub?: string; tone?: "green" | "amber" | "teal" | "gray"; title?: string }) {
  const color = tone === "green" ? "text-[#15803d]" : tone === "amber" ? "text-[#d97706]" : tone === "teal" ? "text-[#0e8f88]" : "text-[#1f3559]";
  return (
    <td className="px-2 py-1 text-center align-middle" title={title}>
      <div className={cn("text-[13px] font-bold leading-none tabular-nums", color)}>{value}</div>
      {sub && <div className="text-[9px] text-[#8595a8] leading-tight whitespace-nowrap">{sub}</div>}
    </td>
  );
}

function ClientTableRow({ c, v, verifyLoading, onChange, onVerifyReload, open, onToggle }: {
  c: ClientRow; v: VRow | undefined; verifyLoading: boolean;
  onChange: () => void; onVerifyReload: () => void; open: boolean; onToggle: () => void;
}) {
  const [fee, setFee] = useState(String(c.fee));
  const [payMsg, setPayMsg] = useState<PayMsgData | null>(null);
  useEffect(() => { setFee(String(c.fee)); }, [c.fee]);
  // A charge changes both the billing numbers and the payment state.
  const reloadBoth = () => { onChange(); onVerifyReload(); };
  // "Not organizing" = several past appointments left in "confirmed" (never moved
  // to session-done/showed). We bill these as shown by default, per agreement.
  const notOrganizing = c.pastDue >= 3;
  const ready = v ? v.readyToCharge : c.readyToCharge;
  const owed = v ? v.amount : c.readyOwed;
  const split = v ? showSplit(v) : null;

  const saveConfig = async (patch: { fee?: number; billing_exempt?: boolean }) => {
    try {
      await fetch("/api/ppa/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ owner_key: c.ownerKey, ...patch }) });
      onChange();
    } catch { /* refresh on next load */ }
  };

  return (
    <>
      {/* Paused clients sink to the bottom (page-level sort) and render muted
          — same live-on-top, faded-paused treatment as the Performance tab. */}
      <tr className={cn("border-b border-[#eef3f8] transition-colors hover:bg-[#f8fafc]",
        ready > 0 && "bg-[#fffdf7]", open && "bg-[#f8fafc]",
        c.status === "paused" && "opacity-50 saturate-50 hover:opacity-90")}>
        {/* Client */}
        <td className="pl-3 pr-2 py-1 align-middle">
          <div className="flex items-center gap-2">
            <button onClick={onToggle} className="text-[#8595a8] hover:text-[#0e8f88] shrink-0">
              {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            </button>
            <div className="min-w-[150px] max-w-[190px]">
              <div className="font-bold text-[13px] text-[#1f3559] leading-tight truncate flex items-center gap-1" title={c.ownerName}>
                <span className={cn("shrink-0 w-1.5 h-1.5 rounded-full", c.status === "paused" ? "bg-[#d97706]" : "bg-[#22c55e]")}
                  title={c.status === "paused" ? "Paused (Clients Master)" : "Live (Clients Master)"} />
                <span className="truncate">{c.ownerName}</span>
                {notOrganizing && (
                  <span title={`${c.pastDue} past appointments left in "confirmed" — not organizing their dashboard. Billed as shown by default per agreement.`}
                    className="shrink-0 px-1 py-0.5 rounded text-[8px] font-bold bg-[#fff7ec] text-[#d97706] border border-[#fcd9a8]">⚠</span>
                )}
              </div>
              <div className="text-[10px] text-[#8595a8] truncate" title={c.business || undefined}>{c.business || "—"}
                {c.status === "paused" && <span className="ml-1 px-1 py-0.5 rounded text-[8px] font-bold bg-[#fff7ec] text-[#d97706]">PAUSED</span>}
              </div>
            </div>
          </div>
        </td>

        {/* Fee */}
        <td className="px-2 py-1 text-center align-middle">
          {c.feeSource === "sheet" ? (
            <span title={`From the financing sheet's notes: "${c.sheetNotes ?? ""}" — edit the sheet to change it.`}
              className="inline-block px-2 py-0.5 text-xs font-bold rounded-lg bg-[#e6f7f5] text-[#0e8f88] border border-[#a7e3df] cursor-help whitespace-nowrap">
              ${c.fee}<span className="font-normal text-[9px]"> · sheet</span>
            </span>
          ) : (
            <div className="relative inline-block" title="No per-show fee found in the financing sheet notes — this dashboard fee is used instead. Add it to the sheet to make the sheet authoritative.">
              <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[11px] text-[#8595a8]">$</span>
              <input value={fee} onChange={(e) => setFee(e.target.value.replace(/[^0-9.]/g, ""))}
                onBlur={() => { const n = Number(fee); if (!isNaN(n) && n !== c.fee) saveConfig({ fee: n }); }}
                className="w-14 pl-4 pr-1 py-0.5 text-xs text-right rounded-lg border border-[#fcd9a8] focus:outline-none focus:border-[#15B7AE]" />
            </div>
          )}
        </td>

        <NumCell value={c.deposits} />
        <NumCell value={c.showRate == null ? "—" : `${c.showRate}%`}
          sub={c.showRate == null ? "no reviews" : `${c.showed}/${c.showed + c.noShowMarked}`}
          tone={c.showRate == null ? "gray" : c.showRate >= 60 ? "green" : "amber"} />
        <NumCell value={c.upcoming} tone="gray" />
        {/* Ready mirrors the payment check's row — the same shows the Charge
            button charges — so count, split, and amount always agree. */}
        <NumCell value={ready}
          sub={split && split.hers > 0 ? `${money(owed)} · ${split.ours}+${split.hers} her` : money(owed)}
          tone={ready > 0 ? "amber" : "gray"}
          title={split ? `${split.ours} we booked · ${split.hers} she booked (no deposit)` : undefined} />
        <NumCell value={c.chargedCount} sub={money(c.chargedAmount)} tone="teal" />
        {/* Deposits taken this calendar month. */}
        <NumCell value={c.depositsThisMonth ?? 0} sub={money(c.depositsThisMonthUsd ?? 0)}
          tone={(c.depositsThisMonth ?? 0) > 0 ? "green" : "gray"} />
        <NumCell value={c.selfBooked ?? 0}
          sub={(c.selfBookedReady ?? 0) > 0 ? `${c.selfBookedReady} to charge` : "their end"}
          tone={(c.selfBookedReady ?? 0) > 0 ? "amber" : "gray"} />
        <NumCell value={c.noAppt} sub={c.noAppt > 0 ? "not booked" : undefined} tone={c.noAppt > 0 ? "amber" : "gray"} />

        {/* Card · status · actions */}
        <td className="px-2 py-1 align-middle whitespace-nowrap"><CardCell v={v} loading={verifyLoading} /></td>
        <td className="px-2 py-1 text-center align-middle">
          {c.billingExempt ? (
            <button onClick={() => saveConfig({ billing_exempt: false })}
              title="Deposit-only client — no per-show service fee, never charged. Click to make billable again."
              className="px-2 py-0.5 rounded-lg text-[10px] font-bold bg-[#f1f5f9] text-[#64748b] border border-[#e2e8f0] hover:border-[#94a3b8]">
              💤 No fee
            </button>
          ) : (
            <div className="flex flex-col items-center gap-0.5">
              <StatusCell v={v} />
              <button onClick={() => saveConfig({ billing_exempt: true })}
                title="Mark as deposit-only: no per-show service fee, excluded from all charging, moved to the bottom section."
                className="text-[9px] text-[#b6c2d0] hover:text-[#64748b] underline decoration-dotted">
                no fee?
              </button>
            </div>
          )}
        </td>
        <td className="pl-2 pr-2 py-1 align-middle whitespace-nowrap"><ActionsCell v={v} onMsg={setPayMsg} onReload={reloadBoth} /></td>

        {/* Profitability, at the far right per request: lifetime value
            (COLLECTED fees + deposits − refunds; owed money is shown in the
            tooltip but not counted until it lands) and the monthly average
            since the client's first deposit. */}
        <NumCell value={money(c.ltv ?? 0)} sub={`${c.monthsActive ?? 1} mo`} tone="teal"
          title={`${money(c.ltvFees ?? 0)} service fees + ${money(c.ltvDeposits ?? 0)} deposits − ${money(c.ltvRefunded ?? 0)} refunded${owed > 0 ? ` · (${money(owed)} still owed — counted once collected)` : ""}`} />
        <NumCell value={money(c.last30 ?? 0)} sub="last 30 days" tone={(c.last30 ?? 0) > 0 ? "teal" : "gray"}
          title={`Rolling 30 days: ${money(c.last30Fees ?? 0)} service fees + ${money(c.last30Deposits ?? 0)} deposits (${c.last30DepositCount ?? 0})${(c.last30Refunded ?? 0) > 0 ? ` − ${money(c.last30Refunded ?? 0)} refunded` : ""}`} />
      </tr>

      {payMsg && (
        <tr className="border-b border-[#eef3f8]"><td colSpan={COLS} className="px-3 pb-2 pt-0"><PayMsg msg={payMsg} /></td></tr>
      )}

      {open && (
        <tr className="border-b border-[#e4ebf2] bg-[#fbfcfe]">
          <td colSpan={COLS} className="px-4 py-3">
            <div className="space-y-3">
              <PaymentDetails v={v} onMsg={setPayMsg} onReload={onVerifyReload} />
              <AppointmentList client={c} onCharged={onChange} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
type Filter = "all" | "ready" | "issues" | "verified" | "auto";

// ── Chat-detected bookings review panel ──────────────────────────────────────
// Bookings that exist only inside a conversation: Claude reads recent chats of
// leads no other billing path covers and flags concrete agreements. A human
// bills or dismisses each — chat evidence never auto-charges.
interface ChatFlag {
  conversation_id: string; owner_key: string; contact_id: string | null; contact_name: string | null;
  detected_when: string | null; evidence: string | null; last_message_at: string | null;
}

function ChatFlagsPanel({ feeByOwner, nameByOwner, onBilled }: {
  feeByOwner: Map<string, number>; nameByOwner: Map<string, string>; onBilled: () => void;
}) {
  const [flags, setFlags] = useState<ChatFlag[]>([]);
  const [lastScanAt, setLastScanAt] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/ppa/chat-flags");
      const j = await res.json();
      if (res.ok) { setFlags(j.flags ?? []); setLastScanAt(j.lastScanAt ?? null); }
    } catch { /* panel is best-effort */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  const scan = async () => {
    setScanning(true); setMsg(null);
    try {
      const res = await fetch("/api/ppa/chat-scan", { method: "POST" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Scan failed");
      setMsg(`Scanned ${j.scanned} conversation${j.scanned === 1 ? "" : "s"} across ${j.clients} clients — ${j.flagged} new booking${j.flagged === 1 ? "" : "s"} flagged${j.partial ? " (time ran out — run again to continue)" : ""}.`);
      load();
    } catch (e) { setMsg(`${e}`.replace("Error: ", "")); }
    finally { setScanning(false); }
  };

  const act = async (f: ChatFlag, bill: boolean) => {
    setBusy(f.conversation_id); setMsg(null);
    try {
      if (bill) {
        const fee = feeByOwner.get(f.owner_key) ?? 30;
        const res = await fetch("/api/ppa/charge", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            appt_id: `chat:${f.conversation_id}`, owner_key: f.owner_key, charged: true, amount: fee,
            note: `Chat-detected booking${f.detected_when ? ` (${f.detected_when})` : ""}${f.contact_name ? ` — ${f.contact_name}` : ""}`,
          }),
        });
        if (!res.ok) throw new Error((await res.json()).error || "Charge record failed");
      }
      const res2 = await fetch("/api/ppa/chat-flags", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: f.conversation_id, action: bill ? "billed" : "dismiss" }),
      });
      if (!res2.ok) throw new Error((await res2.json()).error || "Failed to update flag");
      setFlags((cur) => cur.filter((x) => x.conversation_id !== f.conversation_id));
      if (bill) onBilled();
    } catch (e) { setMsg(`${e}`.replace("Error: ", "")); }
    finally { setBusy(null); }
  };

  return (
    <div className="rounded-xl border border-[#ddd6fe] bg-[#faf8ff] p-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-sm font-bold text-[#1f3559]">💬 Booked in chat</h2>
        {flags.length > 0
          ? <span className="text-xs font-semibold text-[#7c3aed]">{flags.length} to review — found in conversations, no deposit / stage / calendar entry</span>
          : <span className="text-xs text-[#8595a8]">No unreviewed chat bookings{lastScanAt ? ` · last scan ${new Date(lastScanAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : " — run a scan"}</span>}
        <button onClick={scan} disabled={scanning}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-white hover:bg-[#f3e8ff] text-[#7c3aed] border border-[#ddd6fe]">
          {scanning ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />} {scanning ? "Reading chats…" : "Scan chats"}
        </button>
      </div>
      {msg && <div className="mt-1.5 text-[11px] font-semibold text-[#7c3aed]">{msg}</div>}
      {flags.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {flags.map((f) => (
            <div key={f.conversation_id} className="rounded-lg border border-[#e4ebf2] bg-white px-2.5 py-1.5 flex items-start gap-2 flex-wrap">
              <div className="min-w-[160px]">
                <div className="text-[12px] font-bold text-[#1f3559]">{nameByOwner.get(f.owner_key) ?? f.owner_key}</div>
                <div className="text-[11px] text-[#697a91]">{f.contact_name ?? "Unknown lead"}{f.detected_when ? ` · ${f.detected_when}` : ""}</div>
              </div>
              {f.evidence && <div className="flex-1 min-w-[200px] text-[11px] italic text-[#64748b]">&ldquo;{f.evidence}&rdquo;</div>}
              <div className="flex items-center gap-1.5 shrink-0">
                <button onClick={() => act(f, true)} disabled={busy === f.conversation_id}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold border bg-[#e6f7f5] text-[#0e8f88] border-[#a7e3df] hover:bg-[#d6f0ed]">
                  {busy === f.conversation_id ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                  Bill {money(feeByOwner.get(f.owner_key) ?? 30)}
                </button>
                <button onClick={() => act(f, false)} disabled={busy === f.conversation_id}
                  className="px-2 py-1 rounded-lg text-[11px] font-semibold border bg-white text-[#94a3b8] border-[#e4ebf2] hover:border-[#94a3b8]">
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Latest Monday auto-charge run, one line + expandable detail.
interface AutoLogRow { owner_key: string; owner_name: string | null; status: string; amount: number | null; shows: number | null; square_payment_id: string | null; detail: string | null }

function AutoRunBanner() {
  const [run, setRun] = useState<{ runAt: string; rows: AutoLogRow[] } | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    fetch("/api/ppa/autocharge-log").then((r) => r.json()).then((j) => setRun(j.run ?? null)).catch(() => {});
  }, []);
  if (!run || run.rows.length === 0) return null;
  const charged = run.rows.filter((r) => r.status === "charged");
  const skipped = run.rows.filter((r) => r.status === "skipped");
  const failed = run.rows.filter((r) => r.status === "failed");
  const total = charged.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  return (
    <div className={cn("rounded-xl border px-3 py-2 text-[12px]", failed.length ? "border-[#f5c2cf] bg-[#fde8ee] text-[#be123c]" : "border-[#c9dbfb] bg-[#eef7ff] text-[#1d4ed8]")}>
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 w-full text-left">
        <span className="font-bold">⚡ Last auto-charge run</span>
        <span>{new Date(run.runAt).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
        <span>· {charged.length} charged ({money(total)})</span>
        {skipped.length > 0 && <span>· {skipped.length} skipped</span>}
        {failed.length > 0 && <span className="font-bold">· {failed.length} FAILED</span>}
        <span className="ml-auto text-[10px]">{open ? "hide" : "details"}</span>
      </button>
      {open && (
        <div className="mt-1.5 space-y-0.5">
          {run.rows.map((r, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className={cn("font-bold w-[60px] shrink-0", r.status === "charged" ? "text-[#15803d]" : r.status === "failed" ? "text-[#be123c]" : "text-[#b45309]")}>{r.status}</span>
              <span className="font-semibold w-[150px] shrink-0 truncate">{r.owner_name ?? r.owner_key}</span>
              <span>{r.amount != null ? `${money(Number(r.amount))} (${r.shows} shows)` : ""} {r.detail ?? ""}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function V3BillingPage() {
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  // One client expanded at a time — every dropdown open at once was unreadable.
  const [openKey, setOpenKey] = useState<string | null>(null);
  // Payment verification (Square match/cards/flags) loads separately — it's
  // slower than the billing overview, so cards render first and the payment
  // cluster fills in when this arrives.
  const [verify, setVerify] = useState<VReport | null>(null);
  const [verifyLoading, setVerifyLoading] = useState(true);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/ppa/overview${refresh ? "?refresh=1" : ""}`);
      const text = await res.text();
      let json: { clients?: ClientRow[]; missingFromMaster?: string[]; error?: string } = {};
      try { json = JSON.parse(text); } catch { throw new Error(res.ok ? "Unexpected response" : `Server error (${res.status})`); }
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setClients(json.clients ?? []);
      setMissing(json.missingFromMaster ?? []);
    } catch (e) { setError(`${e}`.replace("Error: ", "")); }
    finally { setLoading(false); }
  }, []);
  const loadVerify = useCallback(async () => {
    setVerifyLoading(true); setVerifyError(null);
    try {
      const res = await fetch("/api/ppa/verify");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Payment check failed");
      setVerify(json as VReport);
    } catch (e) { setVerifyError(`${e}`.replace("Error: ", "")); }
    finally { setVerifyLoading(false); }
  }, []);
  useEffect(() => { load(); loadVerify(); }, [load, loadVerify]);

  const feeByOwner = useMemo(() => new Map(clients.map((c) => [c.ownerKey, c.fee])), [clients]);
  const nameByOwner = useMemo(() => new Map(clients.map((c) => [c.ownerKey, c.ownerName])), [clients]);
  const vBy = useMemo(() => {
    const m = new Map<string, VRow>();
    for (const r of verify?.clients ?? []) m.set(r.ownerKey, r);
    return m;
  }, [verify]);

  // Ready numbers prefer the payment check's row — it's what the Charge button
  // charges, so the worklist, the banner, and the button always agree even
  // when the two fetches caught the data at different moments.
  const readyOf = useCallback((c: ClientRow) => {
    const v = vBy.get(c.ownerKey);
    return v ? { ready: v.readyToCharge, owed: v.amount } : { ready: c.readyToCharge, owed: c.readyOwed };
  }, [vBy]);

  const totals = useMemo(() => {
    const t = { count: clients.length, ready: 0, readyUsd: 0, chargedUsd: 0, showed: 0, noShow: 0 };
    for (const c of clients) {
      const r = readyOf(c);
      t.ready += r.ready; t.readyUsd += r.owed;
      t.chargedUsd += c.chargedAmount;
      t.showed += c.showed; t.noShow += c.noShowMarked;
    }
    return t;
  }, [clients, readyOf]);
  const programShowRate = totals.showed + totals.noShow > 0 ? Math.round((totals.showed / (totals.showed + totals.noShow)) * 100) : null;

  // The Monday worklist — clients with appointments ready to charge.
  const worklist = useMemo(() =>
    clients.filter((c) => readyOf(c).ready > 0).sort((a, b) => readyOf(b).owed - readyOf(a).owed),
  [clients, readyOf]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return clients.filter((c) => {
      const v = vBy.get(c.ownerKey);
      if (filter === "ready" && !(c.readyToCharge > 0)) return false;
      if (filter === "issues" && !(v && v.flags.some((f) => f.level !== "info"))) return false;
      if (filter === "verified" && !v?.safeToAutoCharge) return false;
      if (filter === "auto" && !v?.autoCharge) return false;
      if (q && !`${c.ownerName} ${c.business}`.toLowerCase().includes(q)) return false;
      return true;
    // Live clients first, paused sink to the bottom (alphabetical within each
    // group — the sort is stable). Mirrors the Performance tab's ordering.
    }).sort((a, b) => (a.status === "paused" ? 1 : 0) - (b.status === "paused" ? 1 : 0));
  }, [clients, search, filter, vBy]);

  return (
    <div className="p-3 sm:p-4 space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-[#1f3559]">PPS Billing</h1>
          <p className="text-sm text-[#697a91]">Pay-per-show clients (marked &quot;PPA&quot; in the financing sheet&apos;s current month) · charge per completed appointment</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#eef2f7] text-[#34568a] border border-[#e4ebf2]">{totals.count} clients</span>
          <span className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#eef7ff] text-[#1d4ed8] border border-[#c9dbfb]" title="Showed ÷ (showed + no-shows), from your review decisions">
            Show rate {programShowRate == null ? "—" : `${programShowRate}%`}
          </span>
          {totals.chargedUsd > 0 && <span className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#e6f7ee] text-[#15803d] border border-[#86efac]">{money(totals.chargedUsd)} charged</span>}
          {verify && <span className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#e6f7ee] text-[#15803d] border border-[#86efac]" title="Fully verified: Square customer + usable card + no warnings — safe to charge">{verify.totals.ready} verified</span>}
          {verify && verify.totals.blocked > 0 && <span className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#fde8ee] text-[#be123c] border border-[#f5c2cf]" title="Money waiting but something needs your eyes first">{verify.totals.blocked} need review</span>}
          <button onClick={() => { load(true); loadVerify(); }} disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#f1f5f9] hover:bg-[#e6f7f5] text-[#34568a] border border-[#e4ebf2]">
            <RefreshCw size={12} className={loading || verifyLoading ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
      </div>

      {/* Latest Monday auto-charge run (only shows once a run has happened) */}
      <AutoRunBanner />

      {/* Chat-detected bookings — reviewed by a human, then billed via the
          normal charge record (appt_id chat:<conversation>). */}
      <ChatFlagsPanel feeByOwner={feeByOwner} nameByOwner={nameByOwner} onBilled={() => { load(); loadVerify(); }} />

      {verifyError && (
        <div className="rounded-xl border border-[#fcd9a8] bg-[#fffdf7] px-3 py-2 text-[12px] text-[#b45309]">
          Payment check unavailable: {verifyError} — billing numbers still work; card info and the Charge buttons are hidden until it loads (hit Refresh to retry).
        </div>
      )}

      {/* Billing policy: unorganized "confirmed" appointments are billed as shown. */}
      <div className="rounded-xl border border-[#e4ebf2] bg-[#f8fafc] px-3 py-2 text-[12px] text-[#697a91]">
        Appointments left in <strong className="text-[#34568a]">&quot;confirmed&quot;</strong> past their date are billed as <strong className="text-[#34568a]">shown</strong> by default — per agreement, if the artist doesn&apos;t organize their dashboard we charge anyway. Clients with several of these are flagged <span className="px-1 py-0.5 rounded text-[9px] font-bold bg-[#fff7ec] text-[#d97706] border border-[#fcd9a8]">⚠ NOT ORGANIZED</span> so you can nudge them.
        {" "}Leads we sent that the artist booked <strong className="text-[#7c3aed]">on her end</strong> (no deposit through us) also bill the show fee — caught three ways: moved to Session Done (<span className="px-1 py-0.5 rounded text-[9px] font-bold bg-[#f3e8ff] text-[#7c3aed] border border-[#ddd6fe]">Self-booked</span>), sitting on her GHL calendar past its date (<span className="px-1 py-0.5 rounded text-[9px] font-bold bg-[#f3e8ff] text-[#7c3aed] border border-[#ddd6fe]">Calendar</span>), or agreed in the conversation (💬 review panel above). All counted from Aug 1, 2026; booked fully off-platform we can&apos;t see.
      </div>

      {/* PPA names in the financing sheet with no Clients Master row — they
          can't be tracked until they're added to the Master sheet. */}
      {missing.length > 0 && (
        <div className="rounded-xl border border-[#f5c2cf] bg-[#fde8ee] px-3 py-2 text-sm text-[#be123c]">
          <strong>Not in Clients Master:</strong> {missing.join(", ")} — marked PPA in the financing sheet but missing from the Clients Master sheet, so they can&apos;t be tracked here. Add them to the Master sheet to include them.
        </div>
      )}

      {/* Monday worklist — who to charge this week */}
      <div className="rounded-xl border border-[#fcd9a8] bg-[#fffdf7] p-3">
        <div className="flex items-center gap-2 mb-2">
          <CalendarClock size={15} className="text-[#d97706]" />
          <h2 className="text-sm font-bold text-[#1f3559]">To charge</h2>
          {totals.ready > 0
            ? <span className="text-xs font-semibold text-[#d97706]">{totals.ready} appointment{totals.ready === 1 ? "" : "s"} · {money(totals.readyUsd)} across {worklist.length} client{worklist.length === 1 ? "" : "s"}</span>
            : <span className="text-xs text-[#15803d] font-semibold">All caught up 🎉</span>}
        </div>
        {worklist.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {worklist.map((c) => (
              <button key={c.ownerKey} onClick={() => { setFilter("ready"); setSearch(c.ownerName); }}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs bg-white border border-[#fcd9a8] hover:border-[#d97706]">
                <span className="font-semibold text-[#1f3559]">{c.ownerName}</span>
                <span className="text-[#d97706] font-bold">{readyOf(c).ready}</span>
                <span className="text-[#8595a8]">· {money(readyOf(c).owed)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#697a91]" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search client or business…"
            className="w-full pl-8 pr-3 py-2 bg-[#eef2f7] border border-[#e4ebf2] rounded-lg text-sm text-[#1f3559] focus:outline-none focus:border-[#15B7AE]" />
        </div>
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}
          className="px-3 py-2 text-sm rounded-lg border border-[#e4ebf2] bg-white text-[#34568a] focus:outline-none focus:border-[#15B7AE]">
          <option value="all">All clients</option>
          <option value="ready">Ready to charge</option>
          <option value="issues">Needs review</option>
          <option value="verified">Verified only</option>
          <option value="auto">Auto-charge ON</option>
        </select>
      </div>

      {error ? (
        <div className="px-4 py-6 rounded-xl border border-[#e4ebf2] bg-white text-center text-sm text-[#e11d48]">{error}</div>
      ) : loading && clients.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-[#697a91] py-12 justify-center"><Loader2 size={15} className="animate-spin" /> Loading PPS clients, stages &amp; appointments…</div>
      ) : filtered.length === 0 ? (
        <div className="py-12 text-center text-[#8595a8]">No clients match.</div>
      ) : (
        <div className="rounded-xl border border-[#e4ebf2] bg-white overflow-x-auto" style={{ boxShadow: "0 1px 3px rgba(31,53,89,0.06)" }}>
          <table className="w-full text-sm border-collapse min-w-[1320px]">
            <thead>
              <tr className="border-b-2 border-[#e4ebf2] bg-[#f8fafc]">
                {[
                  ["Client", "left"], ["Fee", "center"], ["Deposits", "center"], ["Show %", "center"],
                  ["Upcoming", "center"], ["Ready", "center"], ["Charged", "center"],
                  ["Dep this mo", "center"], ["Self-booked", "center"],
                  ["No appt", "center"], ["Card", "left"], ["Status", "center"], ["Actions", "right"],
                  ["LTV", "center"], ["Last 30d", "center"],
                ].map(([h, align]) => (
                  <th key={h} className={cn("px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[#697a91] whitespace-nowrap",
                    align === "left" ? "text-left first:pl-4" : align === "right" ? "text-right pr-4" : "text-center")}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...filtered.filter((c) => !c.billingExempt), ...filtered.filter((c) => c.billingExempt)].map((c, i, arr) => (
                <Fragment key={c.ownerKey}>
                  {c.billingExempt && (i === 0 || !arr[i - 1].billingExempt) && (
                    <tr className="bg-[#f8fafc] border-y border-[#e4ebf2]">
                      <td colSpan={12} className="px-4 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[#8595a8]">
                        💤 No service fee — deposit-only clients (never charged)
                      </td>
                    </tr>
                  )}
                  <ClientTableRow c={c} v={vBy.get(c.ownerKey)} verifyLoading={verifyLoading}
                    onChange={() => load()} onVerifyReload={() => loadVerify()}
                    open={openKey === c.ownerKey} onToggle={() => setOpenKey((k) => (k === c.ownerKey ? null : c.ownerKey))} />
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
