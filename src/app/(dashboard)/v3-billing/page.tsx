"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Search, ChevronDown, ChevronRight, Check, DollarSign, CalendarClock, Ban, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { PaymentCluster, PaymentDetails, PayMsg, type PayMsgData, type VReport, type VRow } from "@/components/billing/PaymentSection";

// ── Types (mirror /api/ppa/*) ────────────────────────────────────────────────
interface ClientRow {
  ownerKey: string; ownerName: string; business: string; status: string; version: string;
  isPpa: boolean; fee: number; feeSource?: "sheet" | "dashboard"; sheetNotes?: string | null; note: string | null;
  deposits: number; depositTotal: number;
  served: number; pastDue: number; upcoming: number; noshow: number; noAppt: number; selfBooked?: number; selfBookedReady?: number;
  readyToCharge: number; chargedCount: number; chargedAmount: number; readyOwed: number;
  showed: number; noShowMarked: number; excludedCount: number; refundedCount?: number; showRate: number | null;
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
interface Drill {
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
  // the show fee applies. Billable since Aug 1, 2026.
  self_booked: { label: "Self-booked", cls: "bg-[#f3e8ff] text-[#7c3aed] border-[#ddd6fe]" },
};
const isReady = (a: Appt) => !a.charged && !a.excluded && !a.refunded &&
  (a.chargeStatus === "served" || a.chargeStatus === "past_due" || a.chargeStatus === "self_booked");

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

      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-[#697a91]">{drill.appointments.length} deposit{drill.appointments.length === 1 ? "" : "s"} · <strong className="text-[#0e8f88]">{readyCount} to review</strong></span>
        {readyCount > 0 && (
          <button onClick={chargeAllReady}
            className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-[#e6f7f5] hover:bg-[#d6f0ed] text-[#0e8f88] border border-[#a7e3df]">
            <Check size={11} /> Charge all as showed ({money(readyCount * client.fee)})
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
                    <td className="px-2.5 py-1.5 text-[#697a91] whitespace-nowrap">{fmtDate(a.appointmentDate)}</td>
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
                            className={cn("flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-semibold border transition-colors",
                              a.charged ? "bg-[#e6f7ee] text-[#15803d] border-[#86efac]"
                                : ready ? "bg-white text-[#0e8f88] border-[#a7e3df] hover:bg-[#e6f7f5]"
                                : "bg-white text-[#697a91] border-[#e4ebf2] hover:border-[#15B7AE] hover:text-[#0e8f88]")}>
                            {b ? <Loader2 size={11} className="animate-spin" /> : a.charged ? <Check size={11} /> : <DollarSign size={11} />}
                            {a.charged ? `Charged ${a.chargedAmount != null ? money(a.chargedAmount) : ""}` : "Showed"}
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

// ── Client card ──────────────────────────────────────────────────────────────
function ClientCard({ c, v, verifyLoading, onChange, onVerifyReload, defaultOpen }: {
  c: ClientRow; v: VRow | undefined; verifyLoading: boolean;
  onChange: () => void; onVerifyReload: () => void; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const [fee, setFee] = useState(String(c.fee));
  const [payMsg, setPayMsg] = useState<PayMsgData | null>(null);
  useEffect(() => { setFee(String(c.fee)); }, [c.fee]);
  // A charge changes both the billing numbers and the payment state.
  const reloadBoth = () => { onChange(); onVerifyReload(); };
  // "Not organizing" = several past appointments left in "confirmed" (never moved
  // to session-done/showed). We bill these as shown by default, per agreement.
  const notOrganizing = c.pastDue >= 3;

  const saveConfig = async (patch: { fee?: number }) => {
    try {
      await fetch("/api/ppa/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ owner_key: c.ownerKey, ...patch }) });
      onChange();
    } catch { /* refresh on next load */ }
  };

  return (
    <div className={cn("rounded-xl border bg-white w-fit max-w-full", c.readyToCharge > 0 ? "border-[#fcd9a8]" : "border-[#a7e3df]")}>
      <div className="flex items-center gap-2.5 px-3 py-2 flex-wrap">
        <button onClick={() => setOpen((o) => !o)} className="text-[#8595a8] hover:text-[#0e8f88] shrink-0">
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <div className="w-[190px] shrink-0 mr-5">
          <div className="font-bold text-[#1f3559] leading-tight truncate flex items-center gap-1" title={c.ownerName}>
            <span className="truncate">{c.ownerName}</span>
            {notOrganizing && (
              <span title={`${c.pastDue} past appointments left in "confirmed" — not organizing their dashboard. Billed as shown by default per agreement.`}
                className="shrink-0 px-1 py-0.5 rounded text-[9px] font-bold bg-[#fff7ec] text-[#d97706] border border-[#fcd9a8]">⚠ NOT ORGANIZED</span>
            )}
          </div>
          <div className="text-[11px] text-[#8595a8] truncate" title={c.business || undefined}>{c.business || "—"}
            {c.status === "paused" && <span className="ml-1.5 px-1 py-0.5 rounded text-[9px] font-bold bg-[#fff7ec] text-[#d97706]">PAUSED</span>}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <span className="text-[11px] text-[#8595a8]">Fee</span>
          {c.feeSource === "sheet" ? (
            // The financing sheet's latest month states this client's fee — it
            // is the source of truth, so no dashboard edit here. Change it in
            // the sheet and it updates within 15 minutes (payments cron).
            <span title={`From the financing sheet's notes: "${c.sheetNotes ?? ""}" — edit the sheet to change it.`}
              className="px-2 py-0.5 text-xs font-bold rounded-lg bg-[#e6f7f5] text-[#0e8f88] border border-[#a7e3df] cursor-help">
              ${c.fee} <span className="font-normal text-[10px]">· sheet</span>
            </span>
          ) : (
            <div className="relative" title="No per-show fee found in the financing sheet notes — this dashboard fee is used instead. Add it to the sheet to make the sheet authoritative.">
              <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[11px] text-[#8595a8]">$</span>
              <input value={fee} onChange={(e) => setFee(e.target.value.replace(/[^0-9.]/g, ""))}
                onBlur={() => { const n = Number(fee); if (!isNaN(n) && n !== c.fee) saveConfig({ fee: n }); }}
                className="w-14 pl-4 pr-1 py-0.5 text-xs text-right rounded-lg border border-[#fcd9a8] focus:outline-none focus:border-[#15B7AE]" />
            </div>
          )}
        </div>

        <div className="flex items-center gap-2.5 text-center shrink-0">
          <Metric label="Deposits" value={c.deposits} />
          <Metric label="Show %" value={c.showRate == null ? "—" : `${c.showRate}%`} sub={c.showRate == null ? "no reviews" : `${c.showed}/${c.showed + c.noShowMarked}`} tone={c.showRate == null ? "gray" : c.showRate >= 60 ? "green" : "amber"} />
          <Metric label="Upcoming" value={c.upcoming} tone="gray" />
          <Metric label="Ready" value={c.readyToCharge} sub={money(c.readyOwed)} tone={c.readyToCharge > 0 ? "amber" : "gray"} />
          <Metric label="Charged" value={c.chargedCount} sub={money(c.chargedAmount)} tone="teal" />
          {/* The buckets that used to be invisible — without them the row's
              numbers don't add up to Deposits (18 = 4+4+6+2 no-appt+2 test). */}
          {/* Standing column — shows booked on the artist's end (no deposit
              through us) since Aug 1. Always visible so a zero is a fact, not
              a hidden bucket. */}
          <Metric label="Self-booked" value={c.selfBooked ?? 0}
            sub={(c.selfBookedReady ?? 0) > 0 ? `${c.selfBookedReady} to charge` : "their end"}
            tone={(c.selfBookedReady ?? 0) > 0 ? "amber" : "gray"} />
          {c.noAppt > 0 && <Metric label="No appt" value={c.noAppt} sub="not booked" tone="amber" />}
          {c.excludedCount > 0 && <Metric label="Test/excl" value={c.excludedCount} sub="not billed" tone="gray" />}
          {(c.refundedCount ?? 0) > 0 && <Metric label="Refunded" value={c.refundedCount!} sub="deposit returned" tone="gray" />}
        </div>

        {/* Payment method + Charge + Auto — merged from the Payment check tab */}
        <PaymentCluster v={v} loading={verifyLoading} onMsg={setPayMsg} onReload={reloadBoth} />
      </div>

      {payMsg && <PayMsg msg={payMsg} />}

      {open && (
        <div className="px-3 pb-3 border-t border-[#eef3f8] space-y-3">
          <div className="pt-2"><PaymentDetails v={v} onMsg={setPayMsg} onReload={onVerifyReload} /></div>
          <AppointmentList client={c} onCharged={onChange} />
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: "green" | "amber" | "teal" | "gray" }) {
  const color = tone === "green" ? "text-[#15803d]" : tone === "amber" ? "text-[#d97706]" : tone === "teal" ? "text-[#0e8f88]" : "text-[#1f3559]";
  return (
    <div className="min-w-[52px]">
      <div className={cn("text-base font-bold leading-none", color)}>{value}</div>
      <div className="text-[9px] uppercase tracking-wide text-[#a6b3c4] font-semibold mt-0.5">{label}</div>
      {sub && <div className="text-[9px] text-[#8595a8]">{sub}</div>}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
type Filter = "all" | "ready" | "issues" | "verified" | "auto";

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

  const vBy = useMemo(() => {
    const m = new Map<string, VRow>();
    for (const r of verify?.clients ?? []) m.set(r.ownerKey, r);
    return m;
  }, [verify]);

  const totals = useMemo(() => {
    const t = { count: clients.length, ready: 0, readyUsd: 0, chargedUsd: 0, showed: 0, noShow: 0 };
    for (const c of clients) {
      t.ready += c.readyToCharge; t.readyUsd += c.readyOwed;
      t.chargedUsd += c.chargedAmount;
      t.showed += c.showed; t.noShow += c.noShowMarked;
    }
    return t;
  }, [clients]);
  const programShowRate = totals.showed + totals.noShow > 0 ? Math.round((totals.showed / (totals.showed + totals.noShow)) * 100) : null;

  // The Monday worklist — clients with appointments ready to charge.
  const worklist = useMemo(() =>
    clients.filter((c) => c.readyToCharge > 0).sort((a, b) => b.readyOwed - a.readyOwed),
  [clients]);

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
    });
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

      {verifyError && (
        <div className="rounded-xl border border-[#fcd9a8] bg-[#fffdf7] px-3 py-2 text-[12px] text-[#b45309]">
          Payment check unavailable: {verifyError} — billing numbers still work; card info and the Charge buttons are hidden until it loads (hit Refresh to retry).
        </div>
      )}

      {/* Billing policy: unorganized "confirmed" appointments are billed as shown. */}
      <div className="rounded-xl border border-[#e4ebf2] bg-[#f8fafc] px-3 py-2 text-[12px] text-[#697a91]">
        Appointments left in <strong className="text-[#34568a]">&quot;confirmed&quot;</strong> past their date are billed as <strong className="text-[#34568a]">shown</strong> by default — per agreement, if the artist doesn&apos;t organize their dashboard we charge anyway. Clients with several of these are flagged <span className="px-1 py-0.5 rounded text-[9px] font-bold bg-[#fff7ec] text-[#d97706] border border-[#fcd9a8]">⚠ NOT ORGANIZED</span> so you can nudge them.
        {" "}Leads we sent that the artist booked <strong className="text-[#7c3aed]">on her end</strong> (no deposit through us) also bill the show fee once they hit Session Done — they show as <span className="px-1 py-0.5 rounded text-[9px] font-bold bg-[#f3e8ff] text-[#7c3aed] border border-[#ddd6fe]">Self-booked</span>, counted from Aug 1, 2026.
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
                <span className="text-[#d97706] font-bold">{c.readyToCharge}</span>
                <span className="text-[#8595a8]">· {money(c.readyOwed)}</span>
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
        <div className="space-y-2">
          {filtered.map((c) => (
            <ClientCard key={c.ownerKey} c={c} v={vBy.get(c.ownerKey)} verifyLoading={verifyLoading}
              onChange={() => load()} onVerifyReload={() => loadVerify()} defaultOpen={filter === "ready"} />
          ))}
        </div>
      )}
    </div>
  );
}
