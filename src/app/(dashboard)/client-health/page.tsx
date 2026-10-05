"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, RefreshCw, Search } from "lucide-react";
import { useUser } from "@/lib/hooks/useUser";
import { ActivityLog } from "@/components/activity/ActivityLog";
import { cn } from "@/lib/utils";
import type { ClientHealth, Light } from "@/lib/client-health";

/* Client Health (owner, 2026-10-05): each coach sees every Live client in
   their book as green / orange / red — is the client making money from what
   they invest with us, and what's going wrong right now. Red first. Click a
   client for the full math, every reason with its next step, and the notes. */

const LIGHT: Record<Light, { dot: string; bar: string; chip: string; label: string }> = {
  red: { dot: "bg-[#dc2626]", bar: "border-l-[#dc2626]", chip: "bg-[#fdeaea] text-[#b91c1c] border-[#f5c2c2]", label: "Red" },
  orange: { dot: "bg-[#f59e0b]", bar: "border-l-[#f59e0b]", chip: "bg-[#fff3e6] text-[#c2410c] border-[#fcd9a8]", label: "Orange" },
  green: { dot: "bg-[#16a34a]", bar: "border-l-[#16a34a]", chip: "bg-[#e7f6ec] text-[#15803d] border-[#bfe3cd]", label: "Green" },
  unknown: { dot: "bg-[#94a3b8]", bar: "border-l-[#94a3b8]", chip: "bg-[#f1f5f9] text-[#475569] border-[#cbd5e1]", label: "Unknown" },
};

const ICON: Record<string, string> = { red: "🔴", orange: "🟠", unknown: "⚪", green: "🟢", info: "·" };
const TONE: Record<string, string> = { red: "text-[#b91c1c]", orange: "text-[#c2410c]", unknown: "text-[#475569]", green: "text-[#15803d]", info: "text-[#8595a8]" };
const usd = (n: number | null | undefined) => (n == null ? "—" : `$${Math.round(n).toLocaleString("en-US")}`);
const perDollar = (roi: number | null) => (roi == null ? "—" : `$${roi.toFixed(2)}`);
const roiTone = (roi: number | null) =>
  roi == null ? "text-[#8595a8]" : roi >= 1.5 ? "text-[#15803d]" : roi >= 1 ? "text-[#c2410c]" : "text-[#b91c1c]";
const pctTxt = (p: number | null | undefined) => (p == null ? "—" : `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%`);
const monthName = (ym: string) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
/* Leads in the last 30 days against the goal (5 a month per $1/day) — the lib
   pro-rates it in the first month and leaves the first 14 days unjudged. */
function leadGoal(c: ClientHealth) {
  if (!c.leads.goal || c.leads.expected30 == null) return null;
  const ratio = c.leads.ratio;
  return { expected: c.leads.expected30, ratio, tone: ratio == null ? "text-[#1f3559]" : ratio >= 0.8 ? "text-[#15803d]" : ratio >= 0.5 ? "text-[#c2410c]" : "text-[#b91c1c]" };
}
const staleCoach = (c: ClientHealth) => !!c.bookings.coachAsOf && (Date.now() - Date.parse(c.bookings.coachAsOf)) / 86_400_000 > 60;
const fmtDate = (iso: string | null) =>
  iso ? new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—";

export default function ClientHealthPage() {
  const { realRole, loading: userLoading } = useUser();
  const isAdmin = realRole === "admin";
  const [coach, setCoach] = useState("");            // what the picker shows
  const [loadedCoach, setLoadedCoach] = useState(""); // whose book is on screen
  const [coaches, setCoaches] = useState<string[]>([]);
  const [clients, setClients] = useState<ClientHealth[]>([]);
  const [financeError, setFinanceError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Light | "all">("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [howOpen, setHowOpen] = useState(false);

  const loadedRef = useRef("");
  useEffect(() => { loadedRef.current = loadedCoach; }, [loadedCoach]);

  const load = useCallback(async (forCoach: string) => {
    setLoading(true);
    try {
      const r = await fetch(`/api/client-health${forCoach ? `?coach=${encodeURIComponent(forCoach)}` : ""}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "Couldn't load");
      setClients(j.clients ?? []);
      setCoaches(j.coaches ?? []);
      setCoach(j.coach ?? "");
      setLoadedCoach(j.coach ?? "");
      setFinanceError(j.financeError ?? null);
      setError(null);
    } catch (e) {
      // Keep the picker on the book that is actually on screen.
      setCoach((c) => (c === forCoach ? loadedRef.current : c));
      setError(e instanceof Error && e.message !== "Failed to fetch" ? e.message : "Network error — try Refresh");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(""); }, [load]);

  const counts = useMemo(() => ({
    red: clients.filter((c) => c.light === "red").length,
    orange: clients.filter((c) => c.light === "orange").length,
    green: clients.filter((c) => c.light === "green").length,
    unknown: clients.filter((c) => c.light === "unknown").length,
  }), [clients]);
  const book = useMemo(() => {
    // "Unknown" clients' returns rest on a booking count we don't trust — left out.
    const known = clients.filter((c) => c.roi != null && !c.reasons.some((r) => r.key === "bookings-unknown"));
    const earned = known.reduce((t, c) => t + (c.earned ?? 0), 0);
    const invested = known.reduce((t, c) => t + c.invested.total, 0);
    return { earned, invested, roi: invested > 0 ? earned / invested : null, n: known.length };
  }, [clients]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return clients.filter((c) => (filter === "all" || c.light === filter)
      && (!needle || `${c.owner} ${c.business}`.toLowerCase().includes(needle)));
  }, [clients, filter, q]);

  if (userLoading) return <div className="p-6"><Loader2 className="w-5 h-5 animate-spin text-[#697a91]" /></div>;

  return (
    <div className="p-3 md:p-6 max-w-[1100px] mx-auto">
      <div className="flex items-center justify-between gap-2 mb-1">
        <h1 className="text-base sm:text-lg font-semibold text-[#1c2b3a]">❤️ Client Health</h1>
        <button onClick={() => void load(coach)} disabled={loading} title="Refresh"
          className="flex items-center gap-1.5 text-sm border border-[#e4ebf2] rounded-lg px-2.5 py-1.5 hover:bg-[#f6f9fc] disabled:opacity-60">
          <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} /> <span className="hidden sm:inline">Refresh</span>
        </button>
      </div>
      <p className="text-xs text-[#697a91] mb-1">
        Is every client getting leads, bookings and money back on what they invest with us? Red first — open a client for the numbers and the next step.
      </p>
      <button onClick={() => setHowOpen((v) => !v)} aria-expanded={howOpen} className="mb-3 text-[11px] font-medium text-[#0e8f88] underline decoration-dotted underline-offset-2">
        {howOpen ? "Hide" : "How is each number calculated?"}
      </button>
      {howOpen && (
        <ul className="mb-3 rounded-lg border border-[#e4ebf2] bg-white px-3 py-2 text-[11px] text-[#34568a] space-y-1 list-disc pl-6">
          <li><b>Live since</b> = the day their first real lead came in (GHL; team test leads and imported contacts left out).</li>
          <li><b>Leads</b> = funnel leads, one per person per month (some leads arrive twice — counted once). <b>Goal</b> = 5 leads a month for every $1/day of ad budget ($20/day → 100, $10/day → 50), using the live Facebook daily budget.</li>
          <li><b>Bookings</b> = people who booked an appointment in GHL (counted once each); on deposit funnels (V3 / pay-per-show) a paid deposit counts too. <b>Booking %</b> = bookings ÷ leads over the same days. The bookings feed is complete from Jul 30, so longer windows start Aug 1. Wherever the coach logs it, the Performance Tracking % (sessions ÷ leads) is shown too.</li>
          <li><b>Invested</b> = what they paid us since they started (the payment ledger before 2026 + the Financing sheet&apos;s rows marked Paid/PPS from 2026) + their Facebook ad spend on our campaigns (Facebook campaign stats, all-time) + the $50 deposits we keep on pay-per-show.</li>
          <li><b>Earned</b> is an estimate: clients booked × their price. Clients booked = &quot;Sessions Done&quot; your team logs in Performance Tracking (or the paid deposits, if higher); with no sessions logged, the paid deposits or GHL bookings. Price = their offer (funnel / V3 pricing / Clients sheet), else a typical $397 (flagged). Only the first session counts — touch-ups and repeat clients aren&apos;t included, so the real number is usually higher.</li>
          <li>In the list, <b>Booked</b> is the last-30-day booking % for deposit funnels (V3 / pay-per-show); for everyone else it&apos;s the coach&apos;s Performance Tracking % (marked <b>*</b>, greyed when it hasn&apos;t been updated in 60+ days), or GHL bookings when there&apos;s no coach log.</li>
          <li><b>Unknown</b> = live 2+ months, but we can&apos;t see how many they booked (no coach count, an old one, or only part of it) — they may be booking fine and just not moving leads to the booked stage. Not red: ask them, and log it in Performance Tracking.</li>
          <li><b>Per $1</b> = earned ÷ invested. Green needs $1.50+ from day 60 of being live and nothing wrong right now.</li>
        </ul>
      )}

      {isAdmin && (
        <label className="grid gap-0.5 mb-3 max-w-xs">
          <span className="text-[10px] font-medium text-[#697a91]">Coach (admin view)</span>
          <select value={coach} disabled={loading} onChange={(e) => { setCoach(e.target.value); setOpen(null); void load(e.target.value); }}
            className="border border-[#e4ebf2] rounded-lg px-3 py-2 text-sm bg-white disabled:opacity-60">
            <option value="">All coaches</option>
            {coaches.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      )}

      {error && <div className="mb-3 text-sm bg-[#fef2f2] border border-[#fecaca] text-[#b91c1c] rounded-lg px-3 py-2">{error}</div>}
      {financeError && <div className="mb-3 text-xs bg-[#fff7ec] border border-[#fcd9a8] text-[#b45309] rounded-lg px-3 py-2">The Financing sheet didn&apos;t load, so 2026 payments are missing and returns aren&apos;t judged right now. Try Refresh.</div>}

      {loading && clients.length === 0 ? (
        <div className="text-sm text-[#697a91]"><Loader2 className="w-4 h-4 animate-spin inline" /> Checking every client…</div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5 mb-2">
            {(["red", "orange", "unknown", "green"] as Light[]).map((l) => (
              <button key={l} onClick={() => setFilter(filter === l ? "all" : l)} aria-pressed={filter === l}
                className={cn("flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold", LIGHT[l].chip, filter === l && "ring-2 ring-offset-1 ring-[#1f3559]/30")}>
                <span className={cn("w-2 h-2 rounded-full", LIGHT[l].dot)} /> {LIGHT[l].label} {counts[l]}
              </button>
            ))}
            {filter !== "all" && <button onClick={() => setFilter("all")} className="text-xs text-[#697a91] underline px-1">Show all {clients.length}</button>}
            <div className="relative ml-auto w-full sm:w-56">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#a6b3c4]" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search client or business"
                className="w-full border border-[#e4ebf2] rounded-lg pl-8 pr-3 py-1.5 text-sm" />
            </div>
          </div>
          {book.roi != null && !financeError && (
            <p className="text-[11px] text-[#697a91] mb-2">
              {loadedCoach ? `${loadedCoach}'s book` : "All clients"}: ≈{usd(book.earned)} earned on {usd(book.invested)} invested — <b className={roiTone(book.roi)}>{perDollar(book.roi)} back per $1</b> ({book.n} clients with a return we can judge).
            </p>
          )}

          <div className={cn("space-y-1.5 transition-opacity", loading && "opacity-50 pointer-events-none")} aria-busy={loading}>
            {shown.map((c) => <ClientRow key={c.ownerKey} c={c} open={open === c.ownerKey} onToggle={() => setOpen(open === c.ownerKey ? null : c.ownerKey)} />)}
            {shown.length === 0 && !error && <div className="text-sm text-[#8595a8] py-10 text-center">{clients.length ? "No clients match." : "No Live clients in this book."}</div>}
          </div>
          <p className="text-[10px] text-[#8595a8] mt-3">
            Earned is a floor (first session only, at their listed price). Payments count once marked paid; ad spend is all-time on our campaigns. Lead goal = 5 a month per $1/day of budget. Green = nothing wrong right now — and from day 60 of being live, $1.50+ back per $1.
          </p>
        </>
      )}
    </div>
  );
}

function ClientRow({ c, open, onToggle }: { c: ClientHealth; open: boolean; onToggle: () => void }) {
  const issues = c.reasons.filter((r) => r.light === "red" || r.light === "orange" || r.light === "unknown");
  const notes = c.reasons.filter((r) => r.light === "info");
  return (
    <div className={cn("rounded-lg border border-[#e4ebf2] border-l-4 bg-white", LIGHT[c.light].bar)}>
      <button onClick={onToggle} aria-expanded={open} aria-controls={`health-${c.ownerKey}`} aria-label={`${c.owner} — ${LIGHT[c.light].label}`} className="w-full text-left px-3 py-2 hover:bg-[#f7fafc]">
        <div className="flex flex-wrap sm:flex-nowrap items-start gap-x-2 gap-y-1">
          {open ? <ChevronDown size={14} className="mt-1 text-[#8595a8] shrink-0" /> : <ChevronRight size={14} className="mt-1 text-[#8595a8] shrink-0" />}
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-[13px] font-semibold text-[#1f3559] break-words">{c.owner}</span>
              <span className="text-[11px] text-[#697a91] break-words">{c.business}</span>
              <span className="text-[10px] text-[#a6b3c4]">{[c.version || null, c.live.firstLead ? `live since ${fmtDate(c.live.firstLead)}${c.live.days != null ? ` (day ${c.live.days})` : ""}` : "no lead yet", c.coach || null].filter(Boolean).join(" · ")}</span>
            </div>
            {issues.length > 0 ? (
              <ul className="mt-0.5 space-y-0.5">
                {issues.slice(0, 2).map((r) => (
                  <li key={r.key} className={cn("text-[11px] break-words", TONE[r.light])}>
                    {ICON[r.light]} {r.text}
                  </li>
                ))}
                {issues.length > 2 && <li className="text-[10px] text-[#8595a8]">+{issues.length - 2} more</li>}
              </ul>
            ) : (
              <p className="mt-0.5 text-[11px] text-[#15803d]">🟢 On track{notes.some((n) => n.key === "ramping") ? " — new, still ramping up" : ""}</p>
            )}
          </div>
          <div className="w-full sm:w-auto sm:pl-0 shrink-0 grid grid-cols-5 gap-2 sm:gap-3 sm:text-right text-[11px]">
            <div title={c.leads.goal ? `Last 30 days vs goal (${c.leads.goal}/month at $${c.leads.budget}/day)` : c.leads.budgetNote ?? "Leads, last 30 days"}>
              <p className="text-[#a6b3c4]">Leads</p>
              <p className={cn("font-semibold tabular-nums", leadGoal(c)?.tone ?? "text-[#1f3559]")}>{c.leads.last30}{leadGoal(c) ? <span className="font-normal text-[#a6b3c4]">/{leadGoal(c)!.expected}</span> : null}</p>
            </div>
            <div title={`Booking % — ${c.bookings.rowSource}`}>
              <p className="text-[#a6b3c4]">Booked</p>
              <p className={cn("font-semibold tabular-nums", c.bookings.rowSource.startsWith("coach") && staleCoach(c) ? "text-[#a6b3c4]" : "text-[#1f3559]")}>{c.bookings.rowPct == null ? "?" : pctTxt(c.bookings.rowPct)}{c.bookings.rowSource.startsWith("coach") && c.bookings.rowPct != null ? <span className="font-normal text-[#a6b3c4]">*</span> : null}</p>
            </div>
            <div><p className="text-[#a6b3c4]">Invested</p><p className="font-semibold text-[#1f3559] tabular-nums">{usd(c.invested.total)}</p></div>
            <div><p className="text-[#a6b3c4]">Earned</p><p className="font-semibold text-[#1f3559] tabular-nums">{c.earned == null ? "?" : `≈${usd(c.earned)}`}</p></div>
            <div><p className="text-[#a6b3c4]">Per $1</p>{(() => {
              // Bookings unknown: the return is only a floor ("at least"), not a verdict.
              const floor = c.reasons.some((r) => r.key === "bookings-unknown");
              return <p className={cn("font-bold tabular-nums", floor ? "text-[#8595a8]" : roiTone(c.roi))} title={c.roi == null ? "Not judged — open the client to see why" : floor ? "At least this — their booking count is unknown" : undefined}>{c.roi == null ? "?" : `${floor ? "≥" : ""}${perDollar(c.roi)}`}</p>;
            })()}</div>
          </div>
        </div>
      </button>
      {open && <div id={`health-${c.ownerKey}`}><ClientDetail c={c} /></div>}
    </div>
  );
}

function ClientDetail({ c }: { c: ClientHealth }) {
  const issues = c.reasons.filter((r) => r.light !== "info");
  const notes = c.reasons.filter((r) => r.light === "info");
  const line = (label: string, value: React.ReactNode, hint?: string) => (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="text-[#697a91]">{label}{hint && <span className="text-[#a6b3c4]"> · {hint}</span>}</span>
      <span className="font-medium text-[#1f3559] tabular-nums text-right">{value}</span>
    </div>
  );
  return (
    <div className="border-t border-[#eef3f8] px-3 py-3 space-y-3">
      {issues.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold text-[#1f3559] mb-1">What to do</p>
          <ul className="space-y-1">
            {issues.map((r) => (
              <li key={r.key} className="text-[12px] break-words">
                <span className={TONE[r.light]}>{ICON[r.light]} {r.text}</span>
                {r.next && <span className="block pl-5 text-[#34568a]">→ {r.next}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <LeadsAndBookings c={c} />
      <div className="grid gap-3 md:grid-cols-3 text-[12px]">
        <div className="rounded-lg border border-[#eef3f8] p-2">
          <p className="text-[11px] font-semibold text-[#1f3559] mb-1">Invested</p>
          {line("Paid us before 2026", usd(c.invested.feesBefore2026), "payment ledger")}
          {line("Paid us in 2026", usd(c.invested.fees2026), "Financing sheet")}
          {line("Facebook ads", c.ads.tracked ? usd(c.invested.ads) : "not tracked", c.start.cameBack ? "all-time, incl. earlier stint" : "all-time")}
          {c.invested.depositsKept > 0 && line("Deposits we kept", usd(c.invested.depositsKept), "pay-per-show")}
          <div className="border-t border-[#eef3f8] mt-1 pt-1">{line("Total", <b>{usd(c.invested.total)}</b>)}</div>
          <p className="text-[10px] text-[#a6b3c4] mt-1">Started {fmtDate(c.start.date)} ({c.start.source}{c.start.days != null ? `, day ${c.start.days}` : ""}) — payments counted from then</p>
        </div>
        <div className="rounded-lg border border-[#eef3f8] p-2">
          <p className="text-[11px] font-semibold text-[#1f3559] mb-1">Earned (estimate)</p>
          {line("Sessions done", c.booked.sessions ?? "not tracked", c.booked.sessionsAsOf ? `coach log, as of ${fmtDate(c.booked.sessionsAsOf)}` : "coach log")}
          {line("Paid deposits", c.booked.deposits, c.booked.refunded ? `${c.booked.refunded} refunded taken off` : undefined)}
          {line("GHL bookings", c.booked.ghlBookings, "since Jul 30")}
          {line("Clients booked", c.booked.count ?? "unknown", c.booked.basis ?? undefined)}
          {line("Price", usd(c.price.amount), c.price.source)}
          <div className="border-t border-[#eef3f8] mt-1 pt-1">{line("Earned", <b>{c.earned == null ? "unknown" : `≈${usd(c.earned)}`}</b>)}</div>
          <p className={cn("text-[11px] font-bold mt-1", roiTone(c.roi))}>{c.roi == null ? "Return not judged (see notes)" : `${perDollar(c.roi)} back for every $1`}</p>
        </div>
        <div className="rounded-lg border border-[#eef3f8] p-2">
          <p className="text-[11px] font-semibold text-[#1f3559] mb-1">Right now</p>
          {line("Cost per lead", `${usd(c.recent.cpl7)} 7d · ${usd(c.recent.cpl30)} 30d`)}
          {line("Deposits", `${c.recent.deposits14} in 14d · ${c.recent.deposits30} in 30d`, `${c.recent.depositsPrev30} the 30d before`)}
          {line("Ad account", `${c.ads.status ?? "—"}${c.ads.paused ? " · paused" : ""}`)}
          {c.care.hotWaiting > 0 && line("Hot leads waiting", c.care.hotWaiting)}
          {c.care.killPct != null && line("Lose the AI after a call", `${c.care.killPct}%${c.care.killFixed ? " (fixed)" : ""}`)}
          {line("Payment", [c.pay.status, c.pay.thisMonth != null ? usd(c.pay.thisMonth) : null].filter(Boolean).join(" · ") || "—", "this month")}
          {line("Last check-in note", fmtDate(c.lastTouch))}
        </div>
      </div>
      {notes.length > 0 && <p className="text-[11px] text-[#8595a8]">{notes.map((n) => n.text).join(" · ")}</p>}
      <ActivityLog clientKey={c.ownerKey} clientLabel={c.owner} hideRoutine />
    </div>
  );
}

function LeadsAndBookings({ c }: { c: ClientHealth }) {
  const g = leadGoal(c);
  const cell = "px-1 sm:px-2 py-1 text-right tabular-nums";
  return (
    <div className="rounded-lg border border-[#eef3f8] p-2 text-[12px]">
      <p className="text-[11px] font-semibold text-[#1f3559] mb-1">Leads &amp; bookings</p>
      <div className="grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
        <p><span className="text-[#697a91]">Live since</span> <b className="text-[#1f3559]">{c.live.firstLead ? fmtDate(c.live.firstLead) : "no lead yet"}</b>{c.live.days != null && <span className="text-[#a6b3c4]"> · day {c.live.days}</span>}</p>
        <p>
          <span className="text-[#697a91]">Lead goal</span>{" "}
          {c.leads.goal ? <b className="text-[#1f3559]">{c.leads.goal}/month</b> : <span className="text-[#8595a8]">—</span>}
          <span className="text-[#a6b3c4]"> · {c.leads.budget != null ? `$${c.leads.budget}/day` : ""}{c.leads.budgetNote ? `${c.leads.budget != null ? " · " : ""}${c.leads.budgetNote}` : ""}</span>
        </p>
        <p>
          <span className="text-[#697a91]">Leads, last 30 days</span> <b className={g?.tone ?? "text-[#1f3559]"}>{c.leads.last30}</b>
          {g && g.ratio != null && <span className="text-[#a6b3c4]"> · {Math.round(g.ratio * 100)}% of goal{g.expected !== c.leads.goal ? ` (${g.expected} so far)` : ""}</span>}
          <span className="text-[#a6b3c4]"> · {c.leads.last7} in 7 days</span>
        </p>
        <p><span className="text-[#697a91]">Average per month since live</span> <b className="text-[#1f3559]">{c.leads.avgPerMonth != null ? Math.round(c.leads.avgPerMonth) : "—"}</b>{c.leads.sinceLive != null && <span className="text-[#a6b3c4]"> · {c.leads.sinceLive.toLocaleString("en-US")} leads total</span>}</p>
        <p><span className="text-[#697a91]">Bookings, last 30 days</span> <b className="text-[#1f3559]">{c.bookings.last30}</b> <span className="text-[#a6b3c4]">· booking % {pctTxt(c.bookings.pct30)}</span></p>
        <p>
          <span className="text-[#697a91]">Booking % {c.bookings.sinceLabel ?? ""}</span> <b className="text-[#1f3559]">{pctTxt(c.bookings.pctSince)}</b>
          {c.bookings.since != null && <span className="text-[#a6b3c4]"> · {c.bookings.since} of {c.bookings.leadsSince ?? 0} leads</span>}
        </p>
        {c.bookings.coachPct != null && (
          <p><span className="text-[#697a91]">Booking % (coach log)</span> <b className="text-[#1f3559]">{pctTxt(c.bookings.coachPct)}</b><span className="text-[#a6b3c4]"> · sessions ÷ leads{c.bookings.coachAsOf ? `, as of ${fmtDate(c.bookings.coachAsOf)}` : ""}</span></p>
        )}
      </div>
      {c.live.note && <p className="text-[10px] text-[#a6b3c4] mt-1">{c.live.note}</p>}
      <div className="overflow-x-auto mt-2">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-[#8595a8]">
              <th className="px-2 py-1 text-left font-medium">Month</th>
              <th className={cn(cell, "font-medium")}>Leads</th>
              <th className={cn(cell, "font-medium")} title="5 leads a month per $1/day of today's budget, for the days they were live">Goal</th>
              <th className={cn(cell, "font-medium")}>Bookings</th>
              <th className={cn(cell, "font-medium")}>Deposits</th>
              <th className={cn(cell, "font-medium")}>Booking %</th>
            </tr>
          </thead>
          <tbody>
            {c.months.map((m) => {
              const goal = m.goal;
              const tone = m.leads == null || !goal ? "text-[#1f3559]" : m.leads >= goal * 0.8 ? "text-[#15803d]" : m.leads >= goal * 0.5 ? "text-[#c2410c]" : "text-[#b91c1c]";
              return (
                <tr key={m.ym} className="border-t border-[#f1f5f9]">
                  <td className="px-2 py-1 text-[#1f3559] whitespace-nowrap">{monthName(m.ym)}{m.partial ? "*" : ""}</td>
                  <td className={cn(cell, "font-semibold", tone)}>{m.leads ?? "—"}</td>
                  <td className={cn(cell, "text-[#8595a8]")}>{m.leads == null || !goal ? "—" : goal}</td>
                  <td className={cell}>{m.bookings ?? "—"}</td>
                  <td className={cell}>{m.deposits || "—"}</td>
                  <td className={cell}>{pctTxt(m.pct)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-[#a6b3c4] mt-1">* this month so far. Bookings before August aren&apos;t shown — the bookings feed only became complete on Jul 30. Goal uses today&apos;s budget.</p>
    </div>
  );
}
