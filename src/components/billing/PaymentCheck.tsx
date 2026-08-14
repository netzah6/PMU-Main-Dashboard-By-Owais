"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Search, ChevronDown, ChevronRight, ShieldCheck, ShieldAlert, CreditCard, Mail, Phone, User, Star, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

// ── PPS payment-method check + charge green-light (mirrors /api/ppa/verify) ──
// Shows, per PPS client, exactly who Square would charge and on which card,
// and carries the ONLY button in the dashboard that moves money: Charge, which
// re-verifies server-side (/api/ppa/charge-run) before creating one
// idempotent Square payment for the client's ready shows.

interface Flag { key: string; level: "block" | "warn" | "info"; message: string }
interface Card {
  id: string; brand: string; last4: string; expMonth: number | null; expYear: number | null;
  cardholderName: string | null; enabled: boolean; expired: boolean; expiringSoon: boolean; wouldCharge: boolean;
  lastUsedAt?: string | null; isChosenDefault?: boolean;
}
interface Show { apptId: string; contactName: string | null; apptDate: string | null; chargeStatus: string }
interface Match {
  customerId: string; customerName: string; customerEmail: string | null; customerPhone: string | null;
  method: "email" | "phone" | "name" | "business" | null;
  confidence: "high" | "medium" | "low" | "none";
  otherCandidates: Array<{ id: string; name: string; email: string | null }>;
}
interface Row {
  ownerKey: string; ownerName: string; business: string; status: string; version: string;
  email: string | null; phone: string | null;
  fee: number; feeSource?: "sheet" | "dashboard"; sheetNotes?: string | null;
  readyToCharge: number; amount: number; pastDue: number;
  shows: Show[]; match: Match | null; cards: Card[]; flags: Flag[]; safeToAutoCharge: boolean;
}
interface Report {
  clients: Row[]; missingFromMaster: string[]; customerScanTruncated: boolean;
  totals: { clients: number; shows: number; amount: number; ready: number; blocked: number };
  generatedAt: string;
}

const money = (n: number) => "$" + (n || 0).toLocaleString(undefined, { minimumFractionDigits: n % 1 ? 2 : 0 });
const fmtDate = (d: string | null) => {
  if (!d) return "—";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? d : dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};
const expLabel = (c: Card) => (c.expMonth && c.expYear ? `${String(c.expMonth).padStart(2, "0")}/${String(c.expYear).slice(-2)}` : "—");

const METHOD: Record<string, { label: string; cls: string; icon: typeof Mail }> = {
  email:    { label: "matched by email",    cls: "bg-[#e6f7ee] text-[#15803d] border-[#c7edd4]", icon: Mail },
  phone:    { label: "matched by phone",    cls: "bg-[#fff7ec] text-[#d97706] border-[#fcd9a8]", icon: Phone },
  name:     { label: "matched by name",     cls: "bg-[#fde8ee] text-[#e11d48] border-[#f5c2cf]", icon: User },
  business: { label: "matched by business", cls: "bg-[#fde8ee] text-[#e11d48] border-[#f5c2cf]", icon: User },
};

function FlagChip({ f }: { f: Flag }) {
  const cls = f.level === "block" ? "bg-[#fde8ee] text-[#be123c] border-[#f5c2cf]"
    : f.level === "warn" ? "bg-[#fff7ec] text-[#b45309] border-[#fcd9a8]"
    : "bg-[#f1f5f9] text-[#64748b] border-[#e2e8f0]";
  return <div className={cn("px-2 py-1 rounded-lg border text-[11px] leading-snug", cls)}>{f.message}</div>;
}

// compact = the one-line summary in the row header, where horizontal space is
// tight; the full line (cardholder + "would charge") lives in the expansion.
function CardLine({ c, compact }: { c: Card; compact?: boolean }) {
  const dead = c.expired || !c.enabled;
  return (
    <div className={cn("flex items-center gap-x-2 gap-y-0.5 flex-wrap min-w-0 text-[11px]", dead ? "text-[#94a3b8]" : "text-[#34568a]")}>
      <CreditCard size={12} className={cn("shrink-0", c.wouldCharge ? "text-[#0e8f88]" : "text-[#a6b3c4]")} />
      <span className={cn("font-semibold", dead && "line-through")}>{c.brand} ••{c.last4}</span>
      <span>exp {expLabel(c)}</span>
      {!compact && c.cardholderName && <span className="text-[#8595a8] truncate max-w-[140px]">{c.cardholderName}</span>}
      {!compact && c.isChosenDefault && <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[10px] font-bold bg-[#fef9e7] text-[#a16207] border-[#fde68a]"><Star size={9} fill="currentColor" /> your default</span>}
      {!compact && c.wouldCharge && <span className="px-1.5 py-0.5 rounded border text-[10px] font-bold bg-[#e6f7f5] text-[#0e8f88] border-[#a7e3df]">would charge</span>}
      {!compact && c.lastUsedAt && <span className="text-[10px] text-[#8595a8] whitespace-nowrap">last used {fmtDate(c.lastUsedAt)}</span>}
      {c.expired && <span className="px-1.5 py-0.5 rounded border text-[10px] font-bold bg-[#fde8ee] text-[#be123c] border-[#f5c2cf]">expired</span>}
      {!c.enabled && <span className="px-1.5 py-0.5 rounded border text-[10px] font-bold bg-[#f1f5f9] text-[#64748b] border-[#e2e8f0]">disabled</span>}
      {c.expiringSoon && !c.expired && <span className="px-1.5 py-0.5 rounded border text-[10px] font-bold bg-[#fff7ec] text-[#b45309] border-[#fcd9a8]">expiring</span>}
    </div>
  );
}

function ClientRow({ r, onReload }: { r: Row; onReload: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [chargeMsg, setChargeMsg] = useState<{ ok: boolean; text: string; receiptUrl?: string | null } | null>(null);
  const charge = r.cards.find((c) => c.wouldCharge);
  const blocking = r.flags.filter((f) => f.level === "block");
  const warnings = r.flags.filter((f) => f.level === "warn");
  const m = r.match?.method ? METHOD[r.match.method] : null;
  const MIcon = m?.icon;
  const canCharge = r.readyToCharge > 0 && blocking.length === 0 && !!charge;

  const setDefaultCard = async (cardId: string | null) => {
    if (!r.match) return;
    setBusy(true);
    try {
      const res = await fetch("/api/ppa/card-pref", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cardId
          ? { owner_key: r.ownerKey, customer_id: r.match.customerId, card_id: cardId }
          : { owner_key: r.ownerKey, clear: true }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to save");
      onReload();
    } catch (e) {
      setChargeMsg({ ok: false, text: `${e}`.replace("Error: ", "") });
    } finally { setBusy(false); }
  };

  const runCharge = async () => {
    setBusy(true); setConfirming(false); setChargeMsg(null);
    try {
      const res = await fetch("/api/ppa/charge-run", {
        method: "POST", headers: { "Content-Type": "application/json" },
        // The server re-verifies and refuses if the live amount differs from
        // the one that was on screen when the human confirmed.
        body: JSON.stringify({ owner_key: r.ownerKey, expected_amount: r.amount }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Charge failed");
      setChargeMsg({
        ok: true,
        text: json.warning ?? `Charged ${money(json.amount ?? r.amount)} to ${json.card ?? "card"} — Square payment ${json.paymentId}`,
        receiptUrl: json.receiptUrl,
      });
      onReload();
    } catch (e) {
      setChargeMsg({ ok: false, text: `${e}`.replace("Error: ", "") });
    } finally { setBusy(false); }
  };

  return (
    <div className={cn("rounded-xl border bg-white", blocking.length ? "border-[#f5c2cf]" : warnings.length ? "border-[#fcd9a8]" : "border-[#a7e3df]")}>
      <div className="flex items-center gap-2.5 px-3 py-2 flex-wrap">
        <button onClick={() => setOpen((o) => !o)} className="text-[#8595a8] hover:text-[#0e8f88] shrink-0">
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>

        <div className="w-[190px] shrink-0">
          <div className="font-bold text-[#1f3559] leading-tight truncate" title={r.ownerName}>{r.ownerName}</div>
          <div className="text-[11px] text-[#8595a8] truncate" title={r.business || undefined}>{r.business || "—"}</div>
        </div>

        {/* Who Square would charge, and how we decided that's them */}
        <div className="w-[240px] shrink-0">
          {r.match ? (
            <>
              <div className="text-[12px] font-semibold text-[#34568a] truncate" title={r.match.customerName}>{r.match.customerName}</div>
              <div className="flex items-center gap-1 text-[10px]">
                {MIcon && <MIcon size={10} className="shrink-0" />}
                <span className={cn("px-1 py-0.5 rounded border font-semibold whitespace-nowrap", m?.cls)}>{m?.label}</span>
                <span className="text-[#8595a8] truncate" title={r.match.customerEmail ?? undefined}>{r.match.customerEmail ?? "no email"}</span>
              </div>
            </>
          ) : (
            <span className="text-[12px] font-semibold text-[#be123c]">No Square customer</span>
          )}
        </div>

        {/* The card */}
        <div className="w-[190px] shrink-0 min-w-0">
          {charge ? <CardLine c={charge} compact />
            : <span className="text-[11px] font-semibold text-[#be123c]">{r.cards.length ? "No usable card" : "No card on file"}</span>}
          {r.cards.length > 1 && <div className="text-[10px] text-[#8595a8] mt-0.5">{r.cards.length} cards on file</div>}
        </div>

        {/* What it would cost */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="min-w-[70px]" title={r.sheetNotes ? `Financing sheet: ${r.sheetNotes}` : undefined}>
            <div className="text-base font-bold leading-none text-[#1f3559]">{money(r.amount)}</div>
            <div className="text-[9px] uppercase tracking-wide text-[#a6b3c4] font-semibold mt-0.5">{r.readyToCharge} show{r.readyToCharge === 1 ? "" : "s"} × {money(r.fee)}</div>
            <div className={cn("text-[9px] font-semibold", r.feeSource === "sheet" ? "text-[#0e8f88]" : "text-[#b45309]")}>
              {r.feeSource === "sheet" ? "fee from sheet" : "dashboard fee"}
            </div>
          </div>
          {r.safeToAutoCharge ? (
            <span className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold border bg-[#e6f7ee] text-[#15803d] border-[#86efac]">
              <ShieldCheck size={12} /> Verified
            </span>
          ) : (
            <span className={cn("flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold border",
              blocking.length ? "bg-[#fde8ee] text-[#be123c] border-[#f5c2cf]"
                : warnings.length ? "bg-[#fff7ec] text-[#b45309] border-[#fcd9a8]"
                : "bg-[#f1f5f9] text-[#64748b] border-[#e2e8f0]")}>
              <ShieldAlert size={12} /> {blocking.length ? "Do not charge" : warnings.length ? "Check first" : "Nothing due"}
            </span>
          )}

          {/* The green light. Two clicks: arm, then confirm the exact amount
              and card. Disabled whenever anything blocks. */}
          {canCharge && (confirming ? (
            <span className="flex items-center gap-1.5">
              <button onClick={runCharge} disabled={busy}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold border bg-[#0e8f88] text-white border-[#0e8f88] hover:bg-[#0a7a74]">
                {busy ? <Loader2 size={11} className="animate-spin" /> : <Zap size={11} />}
                Yes, charge {money(r.amount)} to ••{charge!.last4}
              </button>
              <button onClick={() => setConfirming(false)} disabled={busy}
                className="px-2 py-1 rounded-lg text-[11px] font-semibold border bg-white text-[#697a91] border-[#e4ebf2] hover:border-[#94a3b8]">
                Cancel
              </button>
            </span>
          ) : (
            <button onClick={() => setConfirming(true)} disabled={busy}
              title={warnings.length ? `Charges despite ${warnings.length} warning${warnings.length === 1 ? "" : "s"} — read them first` : undefined}
              className={cn("flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold border",
                warnings.length
                  ? "bg-[#fff7ec] text-[#b45309] border-[#fcd9a8] hover:border-[#d97706]"
                  : "bg-[#e6f7f5] text-[#0e8f88] border-[#a7e3df] hover:bg-[#d6f0ed]")}>
              {busy ? <Loader2 size={11} className="animate-spin" /> : <Zap size={11} />} Charge {money(r.amount)}
            </button>
          ))}
        </div>
      </div>

      {/* Outcome of a charge attempt (or a card-pick error) */}
      {chargeMsg && (
        <div className={cn("mx-3 mb-2 px-2.5 py-1.5 rounded-lg border text-[11px] font-semibold",
          chargeMsg.ok ? "bg-[#e6f7ee] text-[#15803d] border-[#86efac]" : "bg-[#fde8ee] text-[#be123c] border-[#f5c2cf]")}>
          {chargeMsg.text}
          {chargeMsg.ok && chargeMsg.receiptUrl && (
            <a href={chargeMsg.receiptUrl} target="_blank" rel="noreferrer" className="ml-1.5 underline">receipt ↗</a>
          )}
        </div>
      )}

      {/* Flag summary is always visible — the whole point of the report */}
      {(blocking.length > 0 || warnings.length > 0) && (
        <div className="px-3 pb-2 flex flex-wrap gap-1.5">
          {[...blocking, ...warnings].map((f) => <FlagChip key={f.key} f={f} />)}
        </div>
      )}

      {open && (
        <div className="px-3 pb-3 pt-2 border-t border-[#eef3f8] grid gap-3 md:grid-cols-3">
          <div>
            <h4 className="text-[10px] font-bold uppercase tracking-wider text-[#697a91] mb-1">Matched from (Clients Master)</h4>
            <div className="text-[11px] text-[#34568a] space-y-0.5">
              <div>Email: {r.email ?? <span className="text-[#be123c]">none</span>}</div>
              <div>Phone: {r.phone ?? "—"}</div>
              <div>Status: {r.status}{r.version ? ` · ${r.version}` : ""}</div>
            </div>
            {r.match && (
              <>
                <h4 className="text-[10px] font-bold uppercase tracking-wider text-[#697a91] mt-2 mb-1">Square customer</h4>
                <div className="text-[11px] text-[#34568a] space-y-0.5">
                  <div>{r.match.customerName}</div>
                  <div>{r.match.customerEmail ?? "no email"}</div>
                  <div>{r.match.customerPhone ?? "no phone"}</div>
                  <div className="text-[10px] text-[#8595a8] font-mono">{r.match.customerId}</div>
                </div>
                {r.match.otherCandidates.length > 0 && (
                  <div className="mt-1 text-[11px] text-[#be123c]">
                    Also matched: {r.match.otherCandidates.map((o) => `${o.name}${o.email ? ` (${o.email})` : ""}`).join(", ")}
                  </div>
                )}
              </>
            )}
          </div>

          <div>
            <h4 className="text-[10px] font-bold uppercase tracking-wider text-[#697a91] mb-1">Cards on file (newest first)</h4>
            {r.cards.length === 0
              ? <div className="text-[11px] text-[#be123c]">None — Square has no card for this customer.</div>
              : (
                <div className="space-y-1.5">
                  {r.cards.map((c) => (
                    <div key={c.id} className="flex items-center justify-between gap-2">
                      <CardLine c={c} />
                      {c.isChosenDefault ? (
                        <button onClick={() => setDefaultCard(null)} disabled={busy}
                          title="Stop forcing this card — go back to automatic (last used, then newest)"
                          className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold border bg-white text-[#94a3b8] border-[#e4ebf2] hover:border-[#94a3b8]">
                          clear
                        </button>
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
              No pick = automatic: the card they last paid with, else the newest. Your pick sticks until you clear it — and if that card is ever removed, charging blocks instead of switching silently.
            </div>
            {r.flags.filter((f) => f.level === "info").map((f) => (
              <div key={f.key} className="text-[10px] text-[#8595a8] mt-1">{f.message}</div>
            ))}
          </div>

          <div>
            <h4 className="text-[10px] font-bold uppercase tracking-wider text-[#697a91] mb-1">
              Shows this charge is made of ({r.readyToCharge} × {money(r.fee)})
            </h4>
            {r.shows.length === 0
              ? <div className="text-[11px] text-[#8595a8]">Nothing waiting to be charged.</div>
              : (
                <div className="space-y-0.5 max-h-[160px] overflow-auto">
                  {r.shows.map((s) => (
                    <div key={s.apptId} className="flex items-center justify-between gap-2 text-[11px] text-[#34568a]">
                      <span className="truncate">{s.contactName || "—"}</span>
                      <span className="text-[#8595a8] whitespace-nowrap">
                        {fmtDate(s.apptDate)}
                        {s.chargeStatus === "past_due" && <span className="ml-1 text-[#d97706]">past due</span>}
                      </span>
                    </div>
                  ))}
                </div>
              )}
          </div>
        </div>
      )}
    </div>
  );
}

type Filter = "all" | "issues" | "verified" | "charging";
export default function PaymentCheck() {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch("/api/ppa/verify");
      const text = await res.text();
      let json: Report & { error?: string } = {} as Report;
      try { json = JSON.parse(text); } catch { throw new Error(res.ok ? "Unexpected response" : `Server error (${res.status})`); }
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setReport(json);
    } catch (e) { setError(`${e}`.replace("Error: ", "")); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const rows = report?.clients ?? [];
    const q = search.toLowerCase();
    return rows.filter((r) => {
      if (filter === "issues" && r.flags.every((f) => f.level === "info")) return false;
      if (filter === "verified" && !r.safeToAutoCharge) return false;
      if (filter === "charging" && r.amount <= 0) return false;
      if (q && !`${r.ownerName} ${r.business} ${r.email ?? ""} ${r.match?.customerName ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [report, search, filter]);

  const t = report?.totals;

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <p className="text-sm text-[#697a91] max-w-[640px]">
          The Square customer behind each artist, how that match was made, the card that gets charged, and the shows the
          amount comes from. Cards are read live from Square on every run — a client who changes their card is picked up
          here. The <strong className="text-[#0e8f88]">Charge</strong> button is the green light: it re-verifies on the
          server, then creates one Square payment for that client&apos;s ready shows (a double-click can&apos;t charge twice).
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          {t && <span className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#eef2f7] text-[#34568a] border border-[#e4ebf2]">{t.clients} clients</span>}
          {t && <span className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#e6f7ee] text-[#15803d] border border-[#86efac]">{t.ready} verified</span>}
          {t && t.blocked > 0 && <span className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#fde8ee] text-[#be123c] border border-[#f5c2cf]">{t.blocked} need review</span>}
          {t && <span className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#fff7ec] text-[#b45309] border border-[#fcd9a8]">{money(t.amount)} across {t.shows} shows</span>}
          <button onClick={() => load()} disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#f1f5f9] hover:bg-[#e6f7f5] text-[#34568a] border border-[#e4ebf2]">
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Re-check
          </button>
        </div>
      </div>

      {report?.customerScanTruncated && (
        <div className="rounded-xl border border-[#fcd9a8] bg-[#fffdf7] px-3 py-2 text-[12px] text-[#b45309]">
          Square has more customers than this scan reads (6,000 max), so a &quot;no Square customer&quot; result for anyone matched by name
          may just mean they&apos;re further down the list. Email matches are unaffected.
        </div>
      )}

      {report && report.missingFromMaster.length > 0 && (
        <div className="rounded-xl border border-[#f5c2cf] bg-[#fde8ee] px-3 py-2 text-sm text-[#be123c]">
          <strong>Not in Clients Master:</strong> {report.missingFromMaster.join(", ")} — marked PPS in the financing sheet but with no
          Clients Master row, so there&apos;s no email or business name to match them in Square.
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#697a91]" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search artist, business, email or Square customer…"
            className="w-full pl-8 pr-3 py-2 bg-[#eef2f7] border border-[#e4ebf2] rounded-lg text-sm text-[#1f3559] focus:outline-none focus:border-[#15B7AE]" />
        </div>
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}
          className="px-3 py-2 text-sm rounded-lg border border-[#e4ebf2] bg-white text-[#34568a] focus:outline-none focus:border-[#15B7AE]">
          <option value="all">All clients</option>
          <option value="charging">Would be charged</option>
          <option value="issues">Needs review</option>
          <option value="verified">Verified only</option>
        </select>
      </div>

      {error ? (
        <div className="px-4 py-6 rounded-xl border border-[#e4ebf2] bg-white text-center text-sm text-[#e11d48]">{error}</div>
      ) : loading && !report ? (
        <div className="flex items-center gap-2 text-sm text-[#697a91] py-12 justify-center">
          <Loader2 size={15} className="animate-spin" /> Checking Square customers &amp; cards…
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-12 text-center text-[#8595a8]">No clients match.</div>
      ) : (
        <div className="space-y-2">{filtered.map((r) => <ClientRow key={r.ownerKey} r={r} onReload={() => load()} />)}</div>
      )}

      {report && (
        <div className="text-[10px] text-[#a6b3c4] text-center">
          Checked {new Date(report.generatedAt).toLocaleString()} · Square has no default-card flag, so &quot;would charge&quot; = the newest enabled, unexpired card.
        </div>
      )}
    </div>
  );
}
