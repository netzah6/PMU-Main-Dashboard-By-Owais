"use client";
import { useState } from "react";
import { Loader2, ShieldCheck, ShieldAlert, CreditCard, Mail, Phone, User, Star, Zap, Link2 } from "lucide-react";
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
  method: "email" | "phone" | "name" | "business" | null;
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

export function CardCell({ v, loading }: { v: VRow | undefined; loading: boolean }) {
  if (loading && !v) {
    return <span className="flex items-center gap-1.5 text-[10px] text-[#8595a8]"><Loader2 size={11} className="animate-spin" /> checking…</span>;
  }
  if (!v) return <span className="text-[10px] text-[#b9c3d0]">—</span>;
  const card = v.cards.find((c) => c.wouldCharge);
  if (!card) {
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
        className={cn("inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold border bg-[#e6f7ee] text-[#15803d] border-[#86efac] whitespace-nowrap", notes && "cursor-help")}>
        <ShieldCheck size={12} /> Verified
      </span>
    );
  }
  return (
    <span title={[...blocking, ...warnings].map((f) => f.message).join(" ")}
      className={cn("inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold border whitespace-nowrap cursor-help",
        blocking.length ? "bg-[#fde8ee] text-[#be123c] border-[#f5c2cf]"
          : warnings.length ? "bg-[#fff7ec] text-[#b45309] border-[#fcd9a8]"
          : "bg-[#f1f5f9] text-[#64748b] border-[#e2e8f0]")}>
      <ShieldAlert size={12} /> {blocking.length ? "Do not charge" : warnings.length ? "Check first" : "Nothing due"}
    </span>
  );
}

export function ActionsCell({ v, onMsg, onReload }: {
  v: VRow | undefined;
  onMsg: (m: PayMsgData | null) => void;
  onReload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  if (!v) return null;

  const card = v.cards.find((c) => c.wouldCharge);
  const blocking = v.flags.filter((f) => f.level === "block");
  const warnings = v.flags.filter((f) => f.level === "warn");
  const canCharge = v.readyToCharge > 0 && blocking.length === 0 && !!card;

  const runCharge = async () => {
    setBusy(true); setConfirming(false); onMsg(null);
    try {
      const res = await fetch("/api/ppa/charge-run", {
        method: "POST", headers: { "Content-Type": "application/json" },
        // The server re-verifies and refuses if the live amount differs from
        // the one that was on screen when the human confirmed.
        body: JSON.stringify({ owner_key: v.ownerKey, expected_amount: v.amount }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Charge failed");
      onMsg({
        ok: true,
        text: json.warning ?? `Charged ${money(json.amount ?? v.amount)} to ${json.card ?? "card"} — Square payment ${json.paymentId}`,
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
            <button onClick={runCharge} disabled={busy} title={breakdown}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold border bg-[#0e8f88] text-white border-[#0e8f88] hover:bg-[#0a7a74]">
              {busy ? <Loader2 size={11} className="animate-spin" /> : <Zap size={11} />}
              Yes, charge {money(v.amount)} ({ours}{hers ? `+${hers}` : ""} shows) to ••{card!.last4}
            </button>
            <button onClick={() => setConfirming(false)} disabled={busy}
              className="px-2 py-1 rounded-lg text-[11px] font-semibold border bg-white text-[#697a91] border-[#e4ebf2] hover:border-[#94a3b8]">Cancel</button>
          </span>
        ) : (
          <button onClick={() => setConfirming(true)} disabled={busy}
            title={`${breakdown}${warnings.length ? ` — charges despite ${warnings.length} warning${warnings.length === 1 ? "" : "s"}, read them first` : ""}`}
            className={cn("flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold border",
              warnings.length
                ? "bg-[#fff7ec] text-[#b45309] border-[#fcd9a8] hover:border-[#d97706]"
                : "bg-[#e6f7f5] text-[#0e8f88] border-[#a7e3df] hover:bg-[#d6f0ed]")}>
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Zap size={11} />} Charge {money(v.amount)}
          </button>
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
          className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold border bg-[#fff7ec] text-[#b45309] border-[#fcd9a8] hover:border-[#d97706]">
          ↻ retry {v.retry.nextAttemptAt ? new Date(v.retry.nextAttemptAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "pending"}
        </button>
      )}
      {v.retry && v.retry.status === "exhausted" && (
        <span title={`All ${3} automatic retries declined (last: ${v.retry.lastError ?? "decline"}). Send a payment link or get a new card on file.`}
          className="px-2 py-1 rounded-lg text-[11px] font-bold border bg-[#fde8ee] text-[#be123c] border-[#f5c2cf]">
          ↻ retries exhausted
        </span>
      )}

      {/* Fallback when the stored card declines (or there is no usable card):
          a Square-hosted checkout link for the exact ready amount — the artist
          pays with any card, no card data touches us. */}
      {v.readyToCharge > 0 && (
        <button onClick={makePaymentLink} disabled={busy}
          title={`Create a Square payment page for ${money(v.amount)} and copy the link — for when the card on file declines or there is no usable card. Shows stay in Ready until she pays and you mark them charged.`}
          className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold border bg-white text-[#34568a] border-[#e4ebf2] hover:border-[#15B7AE] hover:text-[#0e8f88]">
          <Link2 size={11} /> Payment link
        </button>
      )}

      {/* Auto-charge switch: Monday 10am Pacific, only when fully Verified —
          any warning makes the cron skip and report instead. */}
      <button onClick={toggleAuto} disabled={busy}
        title={v.autoCharge
          ? "Auto-charge is ON: every Monday 10:00 AM Pacific this client is charged automatically — but only if fully Verified (any warning = skipped and reported)."
          : "Auto-charge is OFF: turn on to charge this client automatically every Monday 10:00 AM Pacific when fully Verified."}
        className={cn("flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-bold border transition-colors",
          v.autoCharge ? "bg-[#0e8f88] text-white border-[#0e8f88]" : "bg-white text-[#94a3b8] border-[#e4ebf2] hover:border-[#a7e3df] hover:text-[#0e8f88]")}>
        <span className={cn("w-2 h-2 rounded-full", v.autoCharge ? "bg-white" : "bg-[#cbd5e1]")} />
        Auto{v.autoCharge ? " ON" : ""}
      </button>
    </div>
  );
}

// ── Drill-down: Square customer + cards with pick-a-default ──────────────────
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
            </div>
          ) : (
            <div className="text-[11px] text-[#be123c]">No Square customer found for {v.email ?? "(no email in Clients Master)"} — they may not have been charged through Square before.</div>
          )}
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
