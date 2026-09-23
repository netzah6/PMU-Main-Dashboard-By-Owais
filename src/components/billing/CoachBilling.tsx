"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { CreditsPanel } from "@/components/billing/CreditsPanel";
import { RecentBilling } from "@/components/billing/RecentBilling";

// PPS Billing as a Client Success Coach sees it: their own clients, the money
// already collected from them, what is still to be charged on their upcoming
// appointments, and account credit they can request.
//
// The "no pending money" rule from 2026-09-08 was lifted on 2026-09-23 at the
// owner's request — a coach now sees the fee, the deposits charged, Upcoming /
// Ready / Self-booked / No appointment and whether a card is on file, because
// chasing a missing card and a client's next appointments is their job.
//
// Still admin-only, and unreachable from this screen: the charge buttons, the
// appointment-by-appointment worklist and the roster-wide to-collect total.

type Client = {
  ownerKey: string; ownerName: string; business: string; status: string; coach: string;
  shows: number; paid: number; lastChargedAt: string | null; credit: number;
  fee: number; feeSource: "sheet" | "dashboard" | null;
  deposits: number; refundedCount: number; chargedCount: number; chargedAmount: number;
  upcoming: number; readyToCharge: number; readyOwed: number;
  selfBooked: number; selfBookedReady: number; noAppt: number; billingExempt: boolean;
};
type Card = { ownerKey: string; hasCard: boolean; brand: string | null; last4: string | null; reason: string | null };

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
const money2 = (n: number) => `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
function fmtDate(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// A count with a smaller line under it — same shape as the admin table's cells
// so the two screens read alike.
function NumCell({ value, sub, tone = "gray", title, className }: {
  value: string | number; sub?: string; tone?: "gray" | "amber" | "green" | "teal"; title?: string; className?: string;
}) {
  const colour = tone === "amber" ? "text-[#b45309]" : tone === "green" ? "text-[#15803d]"
    : tone === "teal" ? "text-[#0e8f88]" : "text-[#1f3559]";
  return (
    <td className={cn("px-2 py-1.5 text-center align-middle whitespace-nowrap", className)} title={title}>
      <div className={cn("text-[13px] font-bold leading-none tabular-nums", colour)}>{value}</div>
      {sub && <div className="text-[9px] text-[#8595a8] leading-tight mt-0.5">{sub}</div>}
    </td>
  );
}

export function CoachBilling() {
  const [clients, setClients] = useState<Client[]>([]);
  const [cards, setCards] = useState<Map<string, Card>>(new Map());
  const [cardsLoading, setCardsLoading] = useState(false);
  const [cardsError, setCardsError] = useState<string | null>(null);
  const [coach, setCoach] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  // Cards are a second pass (~2 Square reads per client) so the table is not
  // held behind them — the column shows "checking…" until they land.
  const loadCards = useCallback(async () => {
    setCardsLoading(true);
    setCardsError(null);
    try {
      const r = await fetch("/api/ppa/coach?cards=1");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Card check failed");
      setCards(new Map(((j.cards as Card[]) ?? []).map((c) => [c.ownerKey, c])));
    } catch (e) {
      setCardsError(e instanceof Error ? e.message : "Card check failed");
    } finally {
      setCardsLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/ppa/coach");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Failed to load");
      setClients((j.clients as Client[]) ?? []);
      setCoach(j.coach ?? "");
      if (j.cardsAvailable && ((j.clients as Client[]) ?? []).length) void loadCards();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [loadCards]);
  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? clients.filter((c) => `${c.ownerName} ${c.business}`.toLowerCase().includes(q)) : clients;
  }, [clients, search]);

  const totals = useMemo(() => ({
    clients: clients.length,
    paid: clients.reduce((t, c) => t + c.paid, 0),
    shows: clients.reduce((t, c) => t + c.shows, 0),
    credit: clients.reduce((t, c) => t + c.credit, 0),
    ready: clients.reduce((t, c) => t + c.readyToCharge, 0),
    owed: clients.reduce((t, c) => t + c.readyOwed, 0),
    upcoming: clients.reduce((t, c) => t + c.upcoming, 0),
    noCard: clients.filter((c) => cards.get(c.ownerKey)?.hasCard === false).length,
  }), [clients, cards]);

  const refresh = () => { setRefreshKey((k) => k + 1); load(); };

  return (
    <div className="p-3 sm:p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-xl font-bold text-[#1f3559]">PPS Billing</h1>
        {coach && (
          <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-[#eef2ff] text-[#3a5a8c] border border-[#c7d2fe]">
            {coach}&apos;s clients
          </span>
        )}
        <button onClick={refresh}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#f1f5f9] hover:bg-[#e6f7f5] text-[#34568a] border border-[#e4ebf2]">
          <RefreshCw size={12} className={cn(loading && "animate-spin")} /> Refresh
        </button>
      </div>

      {error && <div className="px-3 py-2 rounded-lg bg-[#fde8ee] border border-[#f5c2cf] text-[#e11d48] text-sm">{error}</div>}

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
        {[
          { label: "PPS clients", value: `${totals.clients}`, sub: "in your book" },
          { label: "Ready to charge", value: `${totals.ready}`, sub: `${money(totals.owed)} to collect`, accent: totals.ready > 0 },
          { label: "Upcoming", value: `${totals.upcoming}`, sub: "appointments ahead" },
          { label: "Service fees paid", value: money(totals.paid), sub: `${totals.shows.toLocaleString()} shows billed` },
          { label: "Credit owed", value: money(totals.credit), sub: "approved, unused" },
        ].map((k) => (
          <div key={k.label} className={cn("rounded-xl border bg-white px-3 py-2",
            k.accent ? "border-[#fcd9a8] bg-[#fffdf7]" : "border-[#e4ebf2]")}>
            <p className="text-[10px] font-bold uppercase tracking-wide text-[#8595a8]">{k.label}</p>
            <p className={cn("text-lg font-bold leading-tight", k.accent ? "text-[#b45309]" : "text-[#1f3559]")}>{k.value}</p>
            <p className="text-[10px] text-[#8595a8]">{k.sub}</p>
          </div>
        ))}
      </div>

      {totals.noCard > 0 && (
        <div className="px-3 py-2 rounded-lg bg-[#fff7ec] border border-[#fcd9a8] text-[#8a6d3b] text-sm">
          <b>{totals.noCard}</b> of your clients have no usable card on file — their shows cannot be charged until they add one.
        </div>
      )}

      <RecentBilling refreshKey={refreshKey} />

      <CreditsPanel
        clients={clients.map((c) => ({ ownerKey: c.ownerKey, label: `${c.ownerName}${c.business ? ` — ${c.business}` : ""}` }))}
        onChanged={refresh}
      />

      <div className="relative max-w-xs">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#697a91]" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search your clients…"
          className="w-full pl-8 pr-3 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm text-[#1f3559] placeholder:text-[#8595a8] focus:outline-none focus:border-[#15B7AE]" />
      </div>

      {loading && clients.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-[#697a91] py-10 justify-center">
          <Loader2 size={15} className="animate-spin" /> Loading your PPS clients…
        </div>
      ) : !coach ? (
        <div className="rounded-xl border border-[#fcd9a8] bg-[#fffdf7] px-4 py-6 text-sm text-[#8a6d3b]">
          No clients are assigned to your name yet. The Clients Master sheet&apos;s <b>Assigned</b> column is what links a
          client to you — ask an admin to set it to your first name.
        </div>
      ) : shown.length === 0 ? (
        <div className="py-10 text-center text-[#8595a8]">
          {clients.length === 0 ? "None of your clients are on pay-per-show billing." : "No clients match."}
        </div>
      ) : (
        <div className="rounded-xl border border-[#e4ebf2] bg-white overflow-x-auto">
          <table className="w-full text-sm border-collapse min-w-[1080px]">
            <thead>
              <tr className="border-b border-[#e4ebf2] bg-[#f8fafc]">
                {[
                  ["Client", "left"], ["Status", "center"], ["Fee", "center"],
                  ["Deposits · charged", "center"], ["Upcoming", "center"], ["Ready", "center"],
                  ["Self-booked", "center"], ["No appt", "center"], ["Card on file", "left"],
                  ["Paid us", "center"], ["Last charge", "center"], ["Credit", "center"],
                ].map(([h, align]) => (
                  <th key={h} className={cn("px-2 sm:px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[#697a91] whitespace-nowrap",
                    align === "left" ? "text-left first:pl-4" : "text-center")}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((c, i) => {
                const card = cards.get(c.ownerKey);
                return (
                  <tr key={c.ownerKey} className={cn("border-b border-[#eef3f8]", i % 2 ? "bg-[#fafcfe]" : "bg-white",
                    c.status === "paused" && "opacity-60")}>
                    <td className="px-2 sm:px-3 py-1.5 max-w-[46vw] sm:max-w-none">
                      <div className="font-medium text-[#1f3559] truncate">{c.ownerName}</div>
                      <div className="text-[11px] text-[#8595a8] truncate">{c.business}</div>
                    </td>
                    <td className="px-3 py-1.5 text-center text-[#697a91] whitespace-nowrap capitalize text-xs">{c.status || "—"}</td>

                    {/* Fee — the financing sheet's notes win over the dashboard value. */}
                    <NumCell
                      value={c.billingExempt ? "—" : money(c.fee)}
                      sub={c.billingExempt ? "no fee" : c.feeSource === "sheet" ? "sheet" : "dashboard"}
                      tone={c.billingExempt ? "gray" : "teal"}
                      title={c.billingExempt
                        ? "Deposit-only client — no per-show service fee is charged."
                        : c.feeSource === "sheet"
                          ? "Per-show fee from the financing sheet's notes — edit the sheet to change it."
                          : "No per-show fee in the financing sheet notes, so the dashboard fee is used."} />

                    {/* Deposits taken (minus any refunded) and the service fees charged so far. */}
                    <NumCell
                      value={c.refundedCount > 0 ? `${c.deposits} − ${c.refundedCount}` : c.deposits}
                      sub={`${c.chargedCount} charged · ${money(c.chargedAmount)}`}
                      title={`${c.deposits} deposits taken${c.refundedCount > 0 ? ` · ${c.refundedCount} refunded · ${c.deposits - c.refundedCount} kept` : ""}\n${c.chargedCount} service fee${c.chargedCount === 1 ? "" : "s"} charged · ${money(c.chargedAmount)}`} />

                    <NumCell value={c.upcoming} sub={c.upcoming > 0 ? "booked ahead" : undefined}
                      title="Appointments still to happen — nothing is owed for these yet." />

                    {/* Ready = shows that happened and are not charged yet, and what they add up to. */}
                    <NumCell value={c.readyToCharge} sub={money(c.readyOwed)}
                      tone={c.readyToCharge > 0 ? "amber" : "gray"}
                      title={c.readyToCharge > 0
                        ? `${c.readyToCharge} show${c.readyToCharge === 1 ? "" : "s"} × ${money(c.fee)} = ${money(c.readyOwed)} still to charge. An admin runs the charge.`
                        : "Nothing waiting to be charged."} />

                    <NumCell value={c.selfBooked} sub={c.selfBookedReady > 0 ? `${c.selfBookedReady} to charge` : "their end"}
                      tone={c.selfBookedReady > 0 ? "amber" : "gray"}
                      title="Booked on the artist's end with no deposit through us — still our lead, so the show fee applies." />

                    <NumCell value={c.noAppt} sub={c.noAppt > 0 ? "not booked" : undefined}
                      tone={c.noAppt > 0 ? "amber" : "gray"}
                      title="Paid a deposit but has no appointment booked — worth a follow-up." />

                    <td className="px-2 sm:px-3 py-1.5 align-middle whitespace-nowrap">
                      {cardsLoading && !card ? (
                        <span className="flex items-center gap-1.5 text-[10px] text-[#8595a8]"><Loader2 size={11} className="animate-spin" /> checking…</span>
                      ) : !card ? (
                        <span className="text-[10px] text-[#b9c3d0]" title={cardsError ?? undefined}>—</span>
                      ) : card.hasCard ? (
                        <span className="text-[11px] font-semibold text-[#34568a]">{card.brand} ••{card.last4}</span>
                      ) : (
                        <span className="text-[11px] font-semibold text-[#be123c]">{card.reason}</span>
                      )}
                    </td>

                    <NumCell value={money(c.paid)} tone="green" />
                    <td className="px-3 py-1.5 text-center text-[#697a91] whitespace-nowrap text-xs">{fmtDate(c.lastChargedAt)}</td>
                    <td className="px-2 sm:px-3 py-1.5 text-center whitespace-nowrap">
                      {c.credit > 0
                        ? <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-[#e6f7ee] text-[#15803d] border border-[#c7edd4]">{money2(c.credit)}</span>
                        : <span className="text-[#b6c0cd]">—</span>}
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
