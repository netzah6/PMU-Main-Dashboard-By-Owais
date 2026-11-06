"use client";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, ExternalLink, Loader2, RefreshCw, Search } from "lucide-react";
import { cn } from "@/lib/utils";

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
//
// Owner 11/06/2026: the summary is one line, to save scrolling. Credit moved
// into each client's row: open it, see the contacts we charged them for, and
// ask an admin for credit on one contact. Pending until an admin approves it
// in the Account credit panel on the admin view.

type Client = {
  ownerKey: string; ownerName: string; business: string; status: string; coach: string;
  shows: number; paid: number; lastChargedAt: string | null; credit: number;
  fee: number; feeSource: "sheet" | "dashboard" | null;
  deposits: number; refundedCount: number; chargedCount: number; chargedAmount: number;
  upcoming: number; readyToCharge: number; readyOwed: number;
  selfBooked: number; selfBookedReady: number; noAppt: number; billingExempt: boolean;
};
type Card = { ownerKey: string; hasCard: boolean; brand: string | null; last4: string | null; reason: string | null };
type Credit = { id: string; owner_key: string; amount: number; reason: string; status: "pending" | "approved" | "denied" };
type Run = {
  day: string;
  clients: Array<{ ownerKey: string; receiptUrl: string | null; lines: Array<{ name: string; amount: number; source: string }> }>;
};

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
const money2 = (n: number) => `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
function fmtDate(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
// A billing day is a plain date: read at midday so it can't slip a day west of UTC.
const fmtDay = (day: string) => fmtDate(`${day}T12:00:00`);

/* A request is tied to its contact by the reason text. The second form is what
   the admin's one-click "Give credit" writes, so those count here too. */
const creditReason = (name: string, why: string) => `Credit for ${name}: ${why}`;
const isForContact = (reason: string, name: string) =>
  reason.startsWith(`Credit for ${name}:`) || reason.startsWith(`Charged in error for ${name} —`);

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

/* One charged contact, and the coach's way to ask for credit on it. */
function ChargeRow({ ownerKey, clientLabel, charge, credit, onRequested }: {
  ownerKey: string; clientLabel: string;
  charge: { day: string; name: string; amount: number; source: string; receiptUrl: string | null };
  credit?: Credit; onRequested: () => Promise<void>;
}) {
  const [asking, setAsking] = useState(false);
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    if (busy || !why.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/credits/request", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerKey, clientLabel, amount: charge.amount, reason: creditReason(charge.name, why.trim()) }),
      });
      if (!r.ok) throw new Error((await r.json()).error || "Request failed");
      await onRequested();
      setAsking(false);
      setWhy("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="py-1.5 border-b border-[#eef3f8] last:border-b-0">
      <div className="flex items-center gap-3 flex-wrap text-xs">
        <span className="w-[86px] shrink-0 text-[#697a91] tabular-nums">{fmtDay(charge.day)}</span>
        <span className="font-medium text-[#1f3559] min-w-[140px]">{charge.name}</span>
        <span className="font-semibold text-[#34568a] tabular-nums">{money2(charge.amount)}</span>
        {charge.source && <span className="text-[10px] text-[#8595a8]">{charge.source}</span>}
        {charge.receiptUrl && (
          <a href={charge.receiptUrl} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#0e8f88] hover:underline">
            Receipt <ExternalLink size={10} />
          </a>
        )}
        <span className="ml-auto">
          {credit?.status === "pending" ? (
            <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-[#fff7ec] text-[#b45309] border border-[#fcd9a8]">Pending approval</span>
          ) : credit?.status === "approved" ? (
            <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-[#e6f7ee] text-[#15803d] border border-[#c7edd4]">Credited</span>
          ) : !asking ? (
            <span className="flex items-center gap-2">
              {credit?.status === "denied" && <span className="text-[11px] font-semibold text-[#be123c]">Denied</span>}
              <button onClick={() => setAsking(true)}
                className="px-2 py-0.5 rounded-lg text-[11px] font-semibold bg-white text-[#1d4ed8] border border-[#bfdbfe] hover:bg-[#eff6ff]">
                Ask for credit
              </button>
            </span>
          ) : null}
        </span>
      </div>
      {asking && (
        <div className="mt-1.5 flex items-center gap-2 flex-wrap">
          <input autoFocus value={why} onChange={(e) => setWhy(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void send(); }}
            placeholder="Why? For example: she did not go ahead with the service"
            className="flex-1 min-w-[240px] px-2.5 py-1.5 bg-white border border-[#e4ebf2] rounded-lg text-xs text-[#1f3559] placeholder:text-[#8595a8] focus:outline-none focus:border-[#15B7AE]" />
          <button onClick={() => void send()} disabled={busy || !why.trim()}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-[#1d4ed8] text-white disabled:opacity-50">
            {busy && <Loader2 size={11} className="animate-spin" />} Send to admin
          </button>
          <button onClick={() => { setAsking(false); setError(null); }} disabled={busy} className="px-2 py-1.5 text-xs text-[#697a91] hover:underline">Cancel</button>
          {error && <span className="text-[11px] text-[#e11d48]">{error}</span>}
        </div>
      )}
    </li>
  );
}

/* The dropdown under a client: every contact we charged them for, plus their credit. */
function ClientCharges({ client, runs, runsLoading, runsError, credits, onRequested }: {
  client: Client; runs: Run[] | null; runsLoading: boolean; runsError: string | null;
  credits: Credit[]; onRequested: () => Promise<void>;
}) {
  const charges = (runs ?? []).flatMap((run) => run.clients
    .filter((c) => c.ownerKey === client.ownerKey)
    .flatMap((c) => c.lines.map((l) => ({ day: run.day, name: l.name, amount: l.amount, source: l.source, receiptUrl: c.receiptUrl }))));
  const mine = credits.filter((c) => c.owner_key === client.ownerKey);
  const pending = mine.filter((c) => c.status === "pending").reduce((t, c) => t + Number(c.amount), 0);

  return (
    <div className="px-4 py-3 bg-[#f8fafc]">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
        <div>
          <p className="text-sm font-bold text-[#1f3559]">Contacts we charged {client.ownerName} for</p>
          <p className="text-[11px] text-[#697a91]">Charged for a booking that was not right, or the service did not go ahead? Ask an admin for credit.</p>
        </div>
        <div className="rounded-lg border border-[#c7edd4] bg-white px-3 py-1.5 text-right">
          <p className="text-[10px] font-bold uppercase tracking-wide text-[#8595a8]">Credit for {client.ownerName}</p>
          <p className="text-sm font-bold text-[#15803d]">{money2(client.credit)} available</p>
          {pending > 0 && <p className="text-[11px] font-semibold text-[#b45309]">{money2(pending)} pending approval</p>}
        </div>
      </div>
      {runsError ? (
        <p className="text-xs text-[#e11d48]">{runsError}</p>
      ) : runsLoading && !runs ? (
        <div className="flex items-center gap-2 text-xs text-[#697a91] py-2"><Loader2 size={13} className="animate-spin" /> Loading charges…</div>
      ) : charges.length === 0 ? (
        <p className="text-xs text-[#8595a8] py-1">No charges in the last few months.</p>
      ) : (
        <ul className="rounded-lg border border-[#e4ebf2] bg-white px-3">
          {charges.map((ch, i) => (
            <ChargeRow key={`${ch.day}-${ch.name}-${i}`} ownerKey={client.ownerKey}
              clientLabel={`${client.ownerName}${client.business ? ` — ${client.business}` : ""}`}
              charge={ch} credit={mine.find((c) => isForContact(c.reason, ch.name))} onRequested={onRequested} />
          ))}
        </ul>
      )}
    </div>
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
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [credits, setCredits] = useState<Credit[]>([]);

  // The charge history is long, so it is only fetched when a client is opened.
  const loadRuns = useCallback(async () => {
    setRunsLoading(true);
    setRunsError(null);
    try {
      const r = await fetch("/api/ppa/payments");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Failed to load charges");
      setRuns((j.runs as Run[]) ?? []);
    } catch (e) {
      setRunsError(e instanceof Error ? e.message : "Failed to load charges");
    } finally {
      setRunsLoading(false);
    }
  }, []);
  const loadCredits = useCallback(async () => {
    const r = await fetch("/api/credits");
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Failed to load credits");
    setCredits((j.credits as Credit[]) ?? []);
  }, []);
  useEffect(() => { loadCredits().catch(() => {}); }, [loadCredits]);

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

  const refresh = () => {
    load();
    loadCredits().catch(() => {});
    if (runs) void loadRuns();
  };
  const toggleClient = (key: string) => {
    setOpenKey((k) => (k === key ? null : key));
    if (!runs && !runsLoading) void loadRuns();
  };
  /* After a request: the new row must show Pending, and the Credit column with it. */
  const onRequested = async () => { await loadCredits(); };
  const pendingFor = (ownerKey: string) => credits
    .filter((c) => c.owner_key === ownerKey && c.status === "pending")
    .reduce((t, c) => t + Number(c.amount), 0);

  return (
    <div className="p-3 sm:p-4 space-y-3">
      {/* Everything on one line (owner, 11/06/2026): less scrolling. */}
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-xl font-bold text-[#1f3559]">PPA Billing</h1>
        {coach && (
          <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-[#eef2ff] text-[#3a5a8c] border border-[#c7d2fe]">
            {coach}&apos;s clients
          </span>
        )}
        {[
          { label: "PPA clients", value: totals.clients, accent: false },
          { label: "Upcoming appointments", value: totals.upcoming, accent: false },
          { label: "Ready to charge", value: totals.ready, accent: totals.ready > 0 },
        ].map((k) => (
          <span key={k.label} className={cn("inline-flex items-baseline gap-1.5 rounded-lg border bg-white px-2.5 py-1 whitespace-nowrap",
            k.accent ? "border-[#fcd9a8] bg-[#fffdf7]" : "border-[#e4ebf2]")}>
            <b className={cn("text-sm", k.accent ? "text-[#b45309]" : "text-[#1f3559]")}>{k.value}</b>
            <span className="text-[11px] text-[#697a91]">{k.label}</span>
          </span>
        ))}
        {totals.noCard > 0 && (
          <span className="inline-flex items-baseline gap-1.5 rounded-lg border border-[#f5c2cf] bg-[#fff5f7] px-2.5 py-1 whitespace-nowrap"
            title="Their shows cannot be charged until they add a card.">
            <b className="text-sm text-[#be123c]">{totals.noCard}</b>
            <span className="text-[11px] text-[#be123c]">no usable card</span>
          </span>
        )}
        <div className="relative ml-auto w-full sm:w-56">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#697a91]" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search your clients…"
            className="w-full pl-8 pr-3 py-1.5 bg-white border border-[#e4ebf2] rounded-lg text-sm text-[#1f3559] placeholder:text-[#8595a8] focus:outline-none focus:border-[#15B7AE]" />
        </div>
        <button onClick={refresh}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#f1f5f9] hover:bg-[#e6f7f5] text-[#34568a] border border-[#e4ebf2]">
          <RefreshCw size={12} className={cn(loading && "animate-spin")} /> Refresh
        </button>
      </div>

      {error && <div className="px-3 py-2 rounded-lg bg-[#fde8ee] border border-[#f5c2cf] text-[#e11d48] text-sm">{error}</div>}

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
                const isOpen = openKey === c.ownerKey;
                const pending = pendingFor(c.ownerKey);
                return (
                  <Fragment key={c.ownerKey}>
                  <tr onClick={() => toggleClient(c.ownerKey)} title="Click to see the contacts we charged them for"
                    className={cn("border-b border-[#eef3f8] cursor-pointer hover:bg-[#eef6f6]", i % 2 ? "bg-[#fafcfe]" : "bg-white",
                    c.status === "paused" && "opacity-60")}>
                    <td className="px-2 sm:px-3 py-1.5 max-w-[46vw] sm:max-w-none">
                      <div className="flex items-center gap-1">
                        <ChevronRight size={13} className={cn("shrink-0 text-[#94a3b8] transition-transform", isOpen && "rotate-90")} />
                        <div className="min-w-0">
                          <div className="font-medium text-[#1f3559] truncate">{c.ownerName}</div>
                          <div className="text-[11px] text-[#8595a8] truncate">{c.business}</div>
                        </div>
                      </div>
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
                        : pending === 0 && <span className="text-[#b6c0cd]">—</span>}
                      {pending > 0 && <div className="mt-0.5 text-[10px] font-semibold text-[#b45309]">{money2(pending)} pending</div>}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="border-b border-[#e4ebf2]">
                      <td colSpan={12} className="p-0">
                        <ClientCharges client={c} runs={runs} runsLoading={runsLoading} runsError={runsError} credits={credits} onRequested={onRequested} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
