"use client";
import { useMemo, useState } from "react";
import { Loader2, ShieldCheck, ShieldAlert, CreditCard, Mail, Phone, User, Star, Zap, Link2, Search, PieChart } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Payment-method pieces of the merged PPS Billing card ─────────────────────
// Rendered inside each client card: PaymentCluster (header — status, Charge
// button, Auto toggle), PaymentDetails (drill-down — Square customer + cards
// with pick-a-default), PayMsg (charge outcome banner). Data comes from
// /api/ppa/verify; the Charge button posts to /api/ppa/charge-run, which
// re-verifies server-side and creates ONE idempotent Square payment.

export interface VFlag { key: string; level: "block" | "warn" | "info"; message: string }
export interface VCard {
  id: string; brand: string; last4: string; expMonth: number | null; expYear: number | null;
  cardholderName: string | null; enabled: boolean; expired: boolean; expiringSoon: boolean; wouldCharge: boolean;
  lastUsedAt?: string | null; isChosenDefault?: boolean;
}
export interface VMatch {
  customerId: string; customerName: string; customerEmail: string | null; customerPhone: string | null;
  method: "email" | "phone" | "name" | "business" | "manual" | null;
  confidence: "high" | "medium" | "low" | "none";
  otherCandidates: Array<{ id: string; name: string; email: string | null }>;
}
export interface VShow { apptId: string; contactName: string | null; apptDate: string | null; chargeStatus: string }
export interface VRow {
  ownerKey: string; ownerName: string; business: string;
  email: string | null; phone: string | null;
  fee: number; feeSource?: "sheet" | "dashboard"; sheetNotes?: string | null;
  autoCharge: boolean;
  retry?: { status: string; attempts: number; nextAttemptAt: string | null; lastError: string | null } | null;
  readyToCharge: number; amount: number;
  /** Fees before credit, and the approved credit coming off this charge. */
  grossAmount: number; creditApplied: number;
  shows: VShow[];
  match: VMatch | null; cards: VCard[]; flags: VFlag[]; safeToAutoCharge: boolean;
}

// The charge is one amount but two kinds of shows — split them out so the
// human always sees "we booked N, she booked M" before confirming.
export function showSplit(v: VRow): { ours: number; hers: number } {
  let ours = 0, hers = 0;
  for (const s of v.shows) {
    if (s.chargeStatus === "self_booked" || s.chargeStatus === "calendar_booked") hers++;
    else ours++;
  }
  return { ours, hers };
}

// What a PARTIAL charge collects and what it leaves behind (owner request
// 2026-09-26). Mirrors restrictRowToShows in src/lib/ppa-verify.ts — the server
// re-does this off a fresh report and is the authority; this copy only exists
// so the panel can show the numbers before anyone clicks.
export function partialTotals(v: VRow, apptIds: string[]): {
  shows: number; gross: number; credit: number; amount: number;
  remainingShows: number; remainingAmount: number;
} {
  const picked = new Set(apptIds);
  const shows = v.shows.filter((s) => picked.has(s.apptId)).length;
  const gross = shows * v.fee;
  // Credit comes off the gross, capped at the credit the full charge would
  // have used — so a partial can never be bigger than the whole bill.
  const credit = Math.min(v.creditApplied, gross);
  const amount = Math.max(0, gross - credit);
  return {
    shows, gross, credit, amount,
    remainingShows: v.readyToCharge - shows,
    remainingAmount: Math.max(0, v.amount - amount),
  };
}
export interface VReport {
  clients: VRow[]; missingFromMaster: string[]; customerScanTruncated: boolean;
  totals: { clients: number; shows: number; amount: number; ready: number; blocked: number };
  generatedAt: string;
}
export type PayMsgData = { ok: boolean; text: string; receiptUrl?: string | null };

const money = (n: number) => "$" + (n || 0).toLocaleString(undefined, { minimumFractionDigits: n % 1 ? 2 : 0 });
const fmtDate = (d: string | null | undefined) => {
  if (!d) return "—";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? d : dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};
const expLabel = (c: VCard) => (c.expMonth && c.expYear ? `${String(c.expMonth).padStart(2, "0")}/${String(c.expYear).slice(-2)}` : "—");

const METHOD: Record<string, { label: string; cls: string; icon: typeof Mail }> = {
  manual:   { label: "linked by you",       cls: "bg-[#e6f7ee] text-[#15803d] border-[#c7edd4]", icon: Star },
  email:    { label: "matched by email",    cls: "bg-[#e6f7ee] text-[#15803d] border-[#c7edd4]", icon: Mail },
  phone:    { label: "matched by phone",    cls: "bg-[#fff7ec] text-[#d97706] border-[#fcd9a8]", icon: Phone },
  name:     { label: "matched by name",     cls: "bg-[#fde8ee] text-[#e11d48] border-[#f5c2cf]", icon: User },
  business: { label: "matched by business", cls: "bg-[#fde8ee] text-[#e11d48] border-[#f5c2cf]", icon: User },
};

export function FlagChip({ f }: { f: VFlag }) {
  const cls = f.level === "block" ? "bg-[#fde8ee] text-[#be123c] border-[#f5c2cf]"
    : f.level === "warn" ? "bg-[#fff7ec] text-[#b45309] border-[#fcd9a8]"
    : "bg-[#f1f5f9] text-[#64748b] border-[#e2e8f0]";
  return <div className={cn("px-2 py-1 rounded-lg border text-[11px] leading-snug", cls)}>{f.message}</div>;
}

function CardLine({ c }: { c: VCard }) {
  const dead = c.expired || !c.enabled;
  return (
    <div className={cn("flex items-center gap-x-2 gap-y-0.5 flex-wrap min-w-0 text-[11px]", dead ? "text-[#94a3b8]" : "text-[#34568a]")}>
      <CreditCard size={12} className={cn("shrink-0", c.wouldCharge ? "text-[#0e8f88]" : "text-[#a6b3c4]")} />
      <span className={cn("font-semibold", dead && "line-through")}>{c.brand} ••{c.last4}</span>
      <span>exp {expLabel(c)}</span>
      {c.cardholderName && <span className="text-[#8595a8] truncate max-w-[140px]">{c.cardholderName}</span>}
      {c.isChosenDefault && <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[10px] font-bold bg-[#fef9e7] text-[#a16207] border-[#fde68a]"><Star size={9} fill="currentColor" /> your default</span>}
      {c.wouldCharge && <span className="px-1.5 py-0.5 rounded border text-[10px] font-bold bg-[#e6f7f5] text-[#0e8f88] border-[#a7e3df]">will charge</span>}
      {c.lastUsedAt && <span className="text-[10px] text-[#8595a8] whitespace-nowrap">last used {fmtDate(c.lastUsedAt)}</span>}
      {c.expired && <span className="px-1.5 py-0.5 rounded border text-[10px] font-bold bg-[#fde8ee] text-[#be123c] border-[#f5c2cf]">expired</span>}
      {!c.enabled && <span className="px-1.5 py-0.5 rounded border text-[10px] font-bold bg-[#f1f5f9] text-[#64748b] border-[#e2e8f0]">disabled</span>}
      {c.expiringSoon && !c.expired && <span className="px-1.5 py-0.5 rounded border text-[10px] font-bold bg-[#fff7ec] text-[#b45309] border-[#fcd9a8]">expiring</span>}
    </div>
  );
}

export function PayMsg({ msg }: { msg: PayMsgData }) {
  return (
    <div className={cn("mx-3 mb-2 px-2.5 py-1.5 rounded-lg border text-[11px] font-semibold",
      msg.ok ? "bg-[#e6f7ee] text-[#15803d] border-[#86efac]" : "bg-[#fde8ee] text-[#be123c] border-[#f5c2cf]")}>
      {msg.text}
      {msg.ok && msg.receiptUrl && <a href={msg.receiptUrl} target="_blank" rel="noreferrer" className="ml-1.5 underline">open ↗</a>}
    </div>
  );
}

// ── Header cluster: payment status + Charge + Auto toggle ────────────────────
// ── Table cells (the client list is an aligned table) ────────────────────────

export function CardCell({ v, loading, onOpen }: { v: VRow | undefined; loading: boolean; onOpen?: () => void }) {
  if (loading && !v) {
    return <span className="flex items-center gap-1.5 text-[10px] text-[#8595a8]"><Loader2 size={11} className="animate-spin" /> checking…</span>;
  }
  if (!v) return <span className="text-[10px] text-[#b9c3d0]">—</span>;
  const card = v.cards.find((c) => c.wouldCharge);
  if (!card) {
    // No customer matched: the fix lives in the drill-down ("Find & link her
    // Square profile"), so point straight at it instead of a dead-end label.
    if (!v.match && onOpen) {
      return (
        <button onClick={onOpen} title="Open the row to search Square and link her profile"
          className="flex items-center gap-1 text-[11px] font-semibold text-[#be123c] whitespace-nowrap hover:underline">
          No Square customer <span className="text-[9px] font-bold text-[#0e8f88] border border-[#a7e3df] bg-[#e6f7f5] rounded px-1 py-px">link ↓</span>
        </button>
      );
    }
    return <span className="text-[11px] font-semibold text-[#be123c] whitespace-nowrap">{v.match ? (v.cards.length ? "No usable card" : "No card on file") : "No Square customer"}</span>;
  }
  return (
    <>
      <div className="text-[11px] font-semibold text-[#34568a] whitespace-nowrap">{card.brand} ••{card.last4}{card.isChosenDefault && <Star size={9} className="inline ml-0.5 -mt-0.5 text-[#a16207]" fill="currentColor" />}</div>
      <div className="text-[9px] text-[#8595a8] whitespace-nowrap">{card.lastUsedAt ? `last used ${fmtDate(card.lastUsedAt)}` : "never used"}</div>
    </>
  );
}

export function StatusCell({ v }: { v: VRow | undefined }) {
  if (!v) return <span className="text-[10px] text-[#b9c3d0]">—</span>;
  const blocking = v.flags.filter((f) => f.level === "block");
  const warnings = v.flags.filter((f) => f.level === "warn");
  if (v.safeToAutoCharge) {
    // A client can be Verified (will auto-charge) while still carrying the
    // NOT ORGANIZED nudge — keep remaining warnings readable via the tooltip.
    const notes = warnings.map((f) => f.message).join(" ");
    return (
      <span title={notes || undefined}
        className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-bold border bg-[#e6f7ee] text-[#15803d] border-[#86efac] whitespace-nowrap", notes && "cursor-help")}>
        <ShieldCheck size={12} /> Verified
      </span>
    );
  }
  return (
    <span title={[...blocking, ...warnings].map((f) => f.message).join(" ")}
      className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-bold border whitespace-nowrap cursor-help",
        blocking.length ? "bg-[#fde8ee] text-[#be123c] border-[#f5c2cf]"
          : warnings.length ? "bg-[#fff7ec] text-[#b45309] border-[#fcd9a8]"
          : "bg-[#f1f5f9] text-[#64748b] border-[#e2e8f0]")}>
      <ShieldAlert size={12} /> {blocking.length ? "Do not charge" : warnings.length ? "Check first" : "Nothing due"}
    </span>
  );
}

// ── Partial charge: collect SOME of what is owed now ─────────────────────────
// Owner request 2026-09-26. The fee is recorded per appointment, so "part of
// the bill" is a subset of the ready shows: every dollar stays tied to the show
// it paid for, and the shows left out stay in Ready as the remainder. Oldest
// first, because that is the order a balance gets paid down in.
function PartialChargePanel({ v, card, busy, onCancel, onConfirm }: {
  v: VRow; card: VCard; busy: boolean;
  onCancel: () => void; onConfirm: (apptIds: string[]) => void;
}) {
  const ordered = useMemo(
    () => [...v.shows].sort((a, b) => String(a.apptDate ?? "").localeCompare(String(b.apptDate ?? ""))),
    [v.shows]);
  // Start at the smallest partial (the oldest single show) — the admin adds to
  // it, so nothing is ever collected because a checkbox was pre-ticked.
  const [sel, setSel] = useState<Set<string>>(() => new Set(ordered.length ? [ordered[0].apptId] : []));
  // Ticked AND still ready: if a background refresh takes a show away (the
  // Monday cron charged it), it drops out of the total and out of what gets
  // sent, so the amount on screen is always the amount collected.
  const pickedIds = ordered.filter((s) => sel.has(s.apptId)).map((s) => s.apptId);
  const t = partialTotals(v, pickedIds);
  const toggle = (id: string) => setSel((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  return (
    <div className="absolute right-0 z-30 mt-1 w-[320px] rounded-xl border border-[#e4ebf2] bg-white p-2.5 text-left whitespace-normal"
      style={{ boxShadow: "0 8px 20px -6px rgba(0,0,0,0.25)" }}>
      <div className="text-[11px] font-bold text-[#1f3559]">Charge part of it — pick the shows to collect now</div>
      <div className="mt-1.5 space-y-0.5 max-h-[150px] overflow-auto">
        {ordered.map((s) => (
          <label key={s.apptId} className="flex items-center gap-1.5 px-1 py-0.5 rounded cursor-pointer hover:bg-[#f8fafc]">
            <input type="checkbox" checked={sel.has(s.apptId)} onChange={() => toggle(s.apptId)} disabled={busy}
              className="shrink-0 accent-[#0e8f88]" />
            <span className="flex-1 min-w-0 truncate text-[11px] font-semibold text-[#1f3559]">{s.contactName ?? "—"}</span>
            {/* Same purple as the self-booked / calendar / chat chips on the
                billing table: a show the artist booked herself, no deposit. */}
            {(s.chargeStatus === "self_booked" || s.chargeStatus === "calendar_booked" || s.chargeStatus === "chat_booked") && (
              <span title="She booked this one herself — no deposit through us, same fee"
                className="shrink-0 px-1 py-0.5 rounded text-[9px] font-bold bg-[#f3e8ff] text-[#7c3aed] border border-[#ddd6fe]">hers</span>
            )}
            <span className="shrink-0 text-[10px] text-[#8595a8] whitespace-nowrap">{fmtDate(s.apptDate)}</span>
            <span className="shrink-0 text-[10px] font-semibold text-[#0e8f88] whitespace-nowrap">{money(v.fee)}</span>
          </label>
        ))}
      </div>
      {/* Exactly what leaves her card and exactly what is still owed after —
          both spelled out before the confirm button is reachable. */}
      <div className="mt-1.5 pt-1.5 border-t border-[#eef3f8] space-y-0.5 text-[11px]">
        <div className="font-bold text-[#1f3559]">
          Collecting now: {money(t.amount)}
          <span className="ml-1 font-semibold text-[#697a91]">
            ({t.shows} of {v.readyToCharge} shows × {money(v.fee)}{t.credit > 0 ? `, less ${money(t.credit)} credit` : ""})
          </span>
        </div>
        {/* Keyed on the SHOWS left, not the money left. When account credit
            covers the picked subset the amount is $0 while shows are still
            sitting in Ready, and keying on money alone printed "Nothing left
            owed" over a client who still owed for every other show. */}
        <div className={cn("font-semibold", t.remainingShows > 0 ? "text-[#b45309]" : "text-[#15803d]")}>
          {t.remainingShows > 0
            ? `Still in Ready after: ${t.remainingShows} show${t.remainingShows === 1 ? "" : "s"}` +
              (t.remainingAmount > 0 ? ` · ${money(t.remainingAmount)}` : "")
            : "Nothing left in Ready — this settles every ready show"}
        </div>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <button onClick={() => onConfirm(pickedIds)} disabled={busy || t.shows === 0}
          title={`Charge ${card.brand} ••${card.last4} for the ${t.shows} show${t.shows === 1 ? "" : "s"} ticked above`}
          className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold border bg-[#0e8f88] text-white border-[#0e8f88] hover:bg-[#0a7a74] disabled:opacity-50">
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Zap size={11} />}
          {t.amount === 0 && t.credit > 0
            ? `Settle ${t.shows} show${t.shows === 1 ? "" : "s"} with ${money(t.credit)} credit`
            : `Charge ${money(t.amount)} to ••${card.last4}`}
        </button>
        <button onClick={onCancel} disabled={busy}
          className="px-2 py-1 rounded-lg text-[11px] font-semibold border bg-white text-[#697a91] border-[#e4ebf2] hover:border-[#94a3b8]">Cancel</button>
      </div>
      <div className="mt-1 text-[10px] text-[#8595a8]">
        One show is the smallest piece — the fee is recorded per appointment, so a partial always lands on whole shows.
      </div>
    </div>
  );
}

export function ActionsCell({ v, onMsg, onReload }: {
  v: VRow | undefined;
  onMsg: (m: PayMsgData | null) => void;
  onReload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [partialOpen, setPartialOpen] = useState(false);

  if (!v) return null;

  const card = v.cards.find((c) => c.wouldCharge);
  const blocking = v.flags.filter((f) => f.level === "block");
  const warnings = v.flags.filter((f) => f.level === "warn");
  const canCharge = v.readyToCharge > 0 && blocking.length === 0 && !!card;

  // apptIds = a partial charge: only those ready shows are collected. Omitted
  // = the whole ready amount, exactly as before.
  const runCharge = async (apptIds?: string[]) => {
    const expected = apptIds ? partialTotals(v, apptIds).amount : v.amount;
    setBusy(true); setConfirming(false); onMsg(null);
    try {
      const res = await fetch("/api/ppa/charge-run", {
        method: "POST", headers: { "Content-Type": "application/json" },
        // The server re-verifies and refuses if the live amount differs from
        // the one that was on screen when the human confirmed.
        body: JSON.stringify({ owner_key: v.ownerKey, expected_amount: expected, ...(apptIds ? { appt_ids: apptIds } : {}) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Charge failed");
      setPartialOpen(false);
      // After a partial, say what is still owed — the shows left out are back
      // in Ready waiting for the next collection.
      const left = json.partial && json.remainingShows > 0
        ? ` · ${money(json.remainingAmount ?? 0)} still owed (${json.remainingShows} show${json.remainingShows === 1 ? "" : "s"}) — still in Ready`
        : "";
      onMsg({
        ok: true,
        text: json.warning ?? `Charged ${money(json.amount ?? expected)} to ${json.card ?? "card"} — Square payment ${json.paymentId}${left}`,
        receiptUrl: json.receiptUrl,
      });
      onReload();
    } catch (e) {
      // Declines come back from the server already explained (auto-retry
      // schedule included) — show the message as-is.
      onMsg({ ok: false, text: `${e}`.replace("Error: ", "") });
    } finally { setBusy(false); }
  };

  // Square-hosted checkout for the current ready amount — the decline
  // fallback. Copies the link so it can be texted to the artist; the shows
  // stay in Ready until she pays and the admin marks them charged.
  const makePaymentLink = async () => {
    setBusy(true); onMsg(null);
    try {
      const res = await fetch("/api/ppa/payment-link", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner_key: v.ownerKey }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Payment link failed");
      try { await navigator.clipboard.writeText(json.url); } catch { /* copy is best-effort */ }
      onMsg({
        ok: true,
        text: `Payment link for ${money(json.amount)} (${json.shows} shows) copied to clipboard — text it to ${v.ownerName}. When she pays, mark the shows charged in the drill-down.`,
        receiptUrl: json.url,
      });
    } catch (e) {
      onMsg({ ok: false, text: `${e}`.replace("Error: ", "") });
    } finally { setBusy(false); }
  };

  const toggleAuto = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/ppa/config", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner_key: v.ownerKey, auto_charge: !v.autoCharge }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Failed to save");
      onReload();
    } catch (e) {
      onMsg({ ok: false, text: `${e}`.replace("Error: ", "") });
    } finally { setBusy(false); }
  };

  return (
    <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
      {/* The green light. Two clicks: arm, then confirm the exact amount+card.
          The label always spells out the we-booked / she-booked split. */}
      {canCharge && (() => {
        const { ours, hers } = showSplit(v);
        const breakdown = `${v.readyToCharge} show${v.readyToCharge === 1 ? "" : "s"} × ${money(v.fee)}: ${ours} we booked${hers ? ` + ${hers} she booked (no deposit)` : ""}`;
        return confirming ? (
          <span className="flex items-center gap-1.5">
            {/* Arrow, not a bare reference: runCharge's first argument is the
                partial show list, and a click event must never land there. */}
            <button onClick={() => runCharge()} disabled={busy} title={breakdown}
              className="flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-[11px] font-bold border bg-[#0e8f88] text-white border-[#0e8f88] hover:bg-[#0a7a74]">
              {busy ? <Loader2 size={11} className="animate-spin" /> : <Zap size={11} />}
              Yes, charge {money(v.amount)} ({ours}{hers ? `+${hers}` : ""} shows{v.creditApplied ? `, less ${money(v.creditApplied)} credit` : ""}) to ••{card!.last4}
            </button>
            <button onClick={() => setConfirming(false)} disabled={busy}
              className="px-2 py-0.5 rounded-lg text-[11px] font-semibold border bg-white text-[#697a91] border-[#e4ebf2] hover:border-[#94a3b8]">Cancel</button>
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            <button onClick={() => { setPartialOpen(false); setConfirming(true); }} disabled={busy}
              title={`${breakdown}${warnings.length ? ` — charges despite ${warnings.length} warning${warnings.length === 1 ? "" : "s"}, read them first` : ""}`}
              className={cn("flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-[11px] font-bold border",
                warnings.length
                  ? "bg-[#fff7ec] text-[#b45309] border-[#fcd9a8] hover:border-[#d97706]"
                  : "bg-[#e6f7f5] text-[#0e8f88] border-[#a7e3df] hover:bg-[#d6f0ed]")}>
              {busy ? <Loader2 size={11} className="animate-spin" /> : <Zap size={11} />} Charge {money(v.amount)}
              {v.creditApplied > 0 && (
                <span title={`${money(v.grossAmount)} in fees less ${money(v.creditApplied)} approved account credit`}
                  className="ml-1 px-1 py-0.5 rounded text-[9px] font-bold bg-[#eff6ff] text-[#1d4ed8] border border-[#bfdbfe]">
                  −{money(v.creditApplied)}
                </span>
              )}
            </button>
            {/* Collect only part of it (owner request 2026-09-26). Offered from
                two ready shows up: with one show there is nothing smaller than
                its fee to collect, because the fee is recorded per show. */}
            {v.readyToCharge > 1 && (
              <div className="relative">
                <button onClick={() => { setConfirming(false); setPartialOpen((p) => !p); }} disabled={busy}
                  title={`Collect part of the ${money(v.amount)} now — pick which of the ${v.readyToCharge} ready shows to charge; the rest stay in Ready.`}
                  className={cn("flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-semibold border",
                    partialOpen
                      ? "bg-[#e6f7f5] text-[#0e8f88] border-[#15B7AE]"
                      : "bg-white text-[#34568a] border-[#e4ebf2] hover:border-[#15B7AE] hover:text-[#0e8f88]")}>
                  <PieChart size={11} /> Part
                </button>
                {partialOpen && (
                  <PartialChargePanel v={v} card={card!} busy={busy}
                    onCancel={() => setPartialOpen(false)} onConfirm={(ids) => runCharge(ids)} />
                )}
              </div>
            )}
          </span>
        );
      })()}

      {/* Decline-retry status: the card is being retried automatically
          (+1d, +3d, +3d after the decline). Click to stop the loop. */}
      {v.retry && v.retry.status === "active" && (
        <button onClick={async () => {
            setBusy(true);
            try {
              await fetch("/api/ppa/retry", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ owner_key: v.ownerKey }) });
              onMsg({ ok: true, text: "Automatic retries stopped for this client." });
              onReload();
            } finally { setBusy(false); }
          }} disabled={busy}
          title={`Card declined (${v.retry.lastError ?? "decline"}). Retry #${v.retry.attempts + 1} runs ${v.retry.nextAttemptAt ? new Date(v.retry.nextAttemptAt).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : "soon"} at 10am Pacific — schedule is +1 day, then +3, then +3. Click to STOP the automatic retries.`}
          className="flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-bold border bg-[#fff7ec] text-[#b45309] border-[#fcd9a8] hover:border-[#d97706]">
          ↻ retry {v.retry.nextAttemptAt ? new Date(v.retry.nextAttemptAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "pending"}
        </button>
      )}
      {v.retry && v.retry.status === "exhausted" && (
        <span title={`All ${3} automatic retries declined (last: ${v.retry.lastError ?? "decline"}). Send a payment link or get a new card on file.`}
          className="px-2 py-0.5 rounded-lg text-[11px] font-bold border bg-[#fde8ee] text-[#be123c] border-[#f5c2cf]">
          ↻ retries exhausted
        </span>
      )}

      {/* Fallback when the stored card declines (or there is no usable card):
          a Square-hosted checkout link for the exact ready amount — the artist
          pays with any card, no card data touches us. */}
      {v.readyToCharge > 0 && (
        <button onClick={makePaymentLink} disabled={busy}
          title={`Create a Square payment page for ${money(v.amount)} and copy the link — for when the card on file declines or there is no usable card. Shows stay in Ready until she pays and you mark them charged.`}
          className="flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-semibold border bg-white text-[#34568a] border-[#e4ebf2] hover:border-[#15B7AE] hover:text-[#0e8f88]">
          <Link2 size={11} /> Payment link
        </button>
      )}

      {/* Auto-charge switch: Monday 10am Pacific, only when fully Verified —
          any warning makes the cron skip and report instead. */}
      <button onClick={toggleAuto} disabled={busy}
        title={v.autoCharge
          ? "Auto-charge is ON: every Monday 10:00 AM Pacific this client is charged automatically — but only if fully Verified (any warning = skipped and reported)."
          : "Auto-charge is OFF: turn on to charge this client automatically every Monday 10:00 AM Pacific when fully Verified."}
        className={cn("flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border transition-colors",
          v.autoCharge ? "bg-[#0e8f88] text-white border-[#0e8f88]" : "bg-white text-[#94a3b8] border-[#e4ebf2] hover:border-[#a7e3df] hover:text-[#0e8f88]")}>
        <span className={cn("w-2 h-2 rounded-full", v.autoCharge ? "bg-white" : "bg-[#cbd5e1]")} />
        Auto{v.autoCharge ? " ON" : ""}
      </button>
    </div>
  );
}

// ── Drill-down: Square customer + cards with pick-a-default ──────────────────
// Search Square customers and pin one to this client — the self-serve fix
// for "she's in Square but the tab doesn't match her".
function CustomerLinkSearch({ v, busy, onLink }: {
  v: VRow; busy: boolean; onLink: (customerId: string, label: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<Array<{ id: string; name: string; email: string | null; phone: string | null; company: string | null }> | null>(null);

  const search = async () => {
    if (q.trim().length < 3) return;
    setSearching(true);
    try {
      const res = await fetch(`/api/ppa/customer-search?q=${encodeURIComponent(q.trim())}`);
      const json = await res.json();
      setResults(res.ok ? (json.customers ?? []) : []);
    } catch { setResults([]); }
    finally { setSearching(false); }
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="mt-2 flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-semibold border bg-white text-[#34568a] border-[#e4ebf2] hover:border-[#15B7AE] hover:text-[#0e8f88]">
        <Search size={10} /> {v.match ? "Wrong person? Link a different Square profile" : "Find & link her Square profile"}
      </button>
    );
  }

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <input value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") search(); }}
          placeholder="Name, email or phone…" autoFocus
          className="flex-1 px-2 py-1 text-[11px] rounded-lg border border-[#e4ebf2] bg-white text-[#1f3559] focus:outline-none focus:border-[#15B7AE]" />
        <button onClick={search} disabled={searching || q.trim().length < 3}
          className="px-2 py-1 rounded-lg text-[10px] font-semibold border bg-[#e6f7f5] text-[#0e8f88] border-[#a7e3df] disabled:opacity-50">
          {searching ? <Loader2 size={10} className="animate-spin" /> : "Search"}
        </button>
        <button onClick={() => { setOpen(false); setResults(null); setQ(""); }}
          className="px-1.5 py-1 rounded-lg text-[10px] border bg-white text-[#94a3b8] border-[#e4ebf2]">✕</button>
      </div>
      {results !== null && (
        results.length === 0
          ? <div className="text-[10px] text-[#8595a8]">No Square customers match &ldquo;{q}&rdquo;.</div>
          : (
            <div className="space-y-1 max-h-[140px] overflow-auto">
              {results.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-2 px-2 py-1 rounded-lg border border-[#e4ebf2] bg-white">
                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold text-[#1f3559] truncate">{r.name}{r.company ? ` · ${r.company}` : ""}</div>
                    <div className="text-[10px] text-[#8595a8] truncate">{r.email ?? "no email"} · {r.phone ?? "no phone"}</div>
                  </div>
                  <button onClick={() => onLink(r.id, r.name)} disabled={busy}
                    className="shrink-0 px-2 py-0.5 rounded text-[10px] font-bold border bg-[#e6f7f5] text-[#0e8f88] border-[#a7e3df] hover:bg-[#d6f0ed]">
                    Link
                  </button>
                </div>
              ))}
            </div>
          )
      )}
    </div>
  );
}

export function PaymentDetails({ v, onMsg, onReload }: {
  v: VRow | undefined;
  onMsg: (m: PayMsgData | null) => void;
  onReload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!v) return <div className="flex items-center gap-2 text-[11px] text-[#8595a8] py-2"><Loader2 size={11} className="animate-spin" /> Checking Square customer &amp; cards…</div>;

  const m = v.match?.method ? METHOD[v.match.method] : null;
  const MIcon = m?.icon;
  const visibleFlags = v.flags.filter((f) => f.level !== "info");

  const setDefaultCard = async (cardId: string | null) => {
    if (!v.match) return;
    setBusy(true);
    try {
      const res = await fetch("/api/ppa/card-pref", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cardId
          ? { owner_key: v.ownerKey, customer_id: v.match.customerId, card_id: cardId }
          : { owner_key: v.ownerKey, clear: true }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to save");
      onReload();
    } catch (e) {
      onMsg({ ok: false, text: `${e}`.replace("Error: ", "") });
    } finally { setBusy(false); }
  };

  const setLink = async (customerId: string | null, label?: string) => {
    setBusy(true);
    try {
      const res = await fetch("/api/ppa/customer-link", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(customerId
          ? { owner_key: v.ownerKey, customer_id: customerId, customer_label: label }
          : { owner_key: v.ownerKey, clear: true }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to save link");
      onMsg({ ok: true, text: customerId ? `Linked to ${label ?? customerId} — this profile is now used for all charges.` : "Manual link removed — back to automatic matching." });
      onReload();
    } catch (e) {
      onMsg({ ok: false, text: `${e}`.replace("Error: ", "") });
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-2">
      {visibleFlags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">{visibleFlags.map((f) => <FlagChip key={f.key} f={f} />)}</div>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <h4 className="text-[10px] font-bold uppercase tracking-wider text-[#697a91] mb-1">Square customer</h4>
          {v.match ? (
            <div className="text-[11px] text-[#34568a] space-y-0.5">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-semibold">{v.match.customerName}</span>
                {m && MIcon && <span className={cn("flex items-center gap-1 px-1 py-0.5 rounded border text-[10px] font-semibold whitespace-nowrap", m.cls)}><MIcon size={9} /> {m.label}</span>}
              </div>
              <div>{v.match.customerEmail ?? "no email"} · {v.match.customerPhone ?? "no phone"}</div>
              <div className="text-[10px] text-[#8595a8] font-mono">{v.match.customerId}</div>
              {v.match.otherCandidates.length > 0 && (
                <div className="text-[#be123c]">Also matched: {v.match.otherCandidates.map((o) => `${o.name}${o.email ? ` (${o.email})` : ""}`).join(", ")}</div>
              )}
              <div className="text-[10px] text-[#8595a8] pt-1">Sheet has: {v.email ?? "no email"} · {v.phone ?? "no phone"}</div>
              {v.match.method === "manual" && (
                <button onClick={() => setLink(null)} disabled={busy}
                  className="mt-1 px-1.5 py-0.5 rounded text-[10px] font-semibold border bg-white text-[#94a3b8] border-[#e4ebf2] hover:border-[#94a3b8]">
                  unlink — back to automatic matching
                </button>
              )}
            </div>
          ) : (
            <div className="text-[11px] text-[#be123c]">No Square customer found for {v.email ?? "(no email in Clients Master)"} — they may not have been charged through Square before.</div>
          )}
          {/* Self-serve fix for a wrong or missing match: search Square by
              name/email/phone and pin the right profile. */}
          <CustomerLinkSearch v={v} busy={busy} onLink={setLink} />
        </div>
        <div>
          <h4 className="text-[10px] font-bold uppercase tracking-wider text-[#697a91] mb-1">Cards on file (newest first)</h4>
          {v.cards.length === 0
            ? <div className="text-[11px] text-[#be123c]">None — Square has no card for this customer.</div>
            : (
              <div className="space-y-1.5">
                {v.cards.map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-2">
                    <CardLine c={c} />
                    {c.isChosenDefault ? (
                      <button onClick={() => setDefaultCard(null)} disabled={busy}
                        title="Stop forcing this card — go back to automatic (last used, then newest)"
                        className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold border bg-white text-[#94a3b8] border-[#e4ebf2] hover:border-[#94a3b8]">clear</button>
                    ) : c.enabled && !c.expired ? (
                      <button onClick={() => setDefaultCard(c.id)} disabled={busy}
                        title="Always charge this card for this client"
                        className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold border bg-white text-[#0e8f88] border-[#a7e3df] hover:bg-[#e6f7f5]">
                        <Star size={9} /> use this card
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          <div className="text-[10px] text-[#8595a8] mt-1.5">
            No pick = automatic: the card they last paid with, else the newest. Your pick sticks until you clear it — if that card is ever removed, charging blocks instead of switching silently.
          </div>
        </div>
      </div>
    </div>
  );
}
