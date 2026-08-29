"use client";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Loader2, ChevronRight, Sparkles, MessageCircle } from "lucide-react";

interface Lead {
  id: string;
  contact_id: string | null;
  location_id: string | null;
  contact_name: string | null;
  email: string | null;
  date_added: string | null;
  status: string;
  priority: number;
  ai_off: boolean;
  price_signal: string | null;
  activity_date: string | null;
  // Raw tag booleans from the view — let us split bookings by PATH even after
  // a lead turns "confirmed": an AI offer only ever happens in chat, so
  // booked+offer_made = booked through the AI chat, booked alone = straight
  // through the funnel.
  booked: boolean;
  offer_made: boolean;
  fanbasis: boolean;
}

// A healthy account books 35%+ of its leads — below that the funnel needs work.
const HEALTHY_BOOK_PCT = 35;

// Status config — emojis/labels match the briefing legend.
const STATUS: Record<string, { emoji: string; legend: string; short: (aiOff: boolean) => string }> = {
  confirmed:          { emoji: "✅", legend: "Confirmed deposit (fanbasis buyer)",            short: () => "confirmed + deposit" },
  ai_booked_pending:  { emoji: "🤖", legend: "AI conversation → booked, deposit pending",      short: () => "AI conv → booked, no deposit" },
  funnel_drop:        { emoji: "📋", legend: "Funnel drop → booked, deposit pending, no AI yet", short: () => "funnel → booked, no deposit" },
  offer_not_booked:   { emoji: "🔥", legend: "AI conversation, offer made, not booked",        short: (a) => a ? "AI conv, offer made, AI off" : "AI conv, offer made, not booked" },
  ai_active_no_offer: { emoji: "🟡", legend: "AI active, no offer yet",                         short: () => "AI active, no offer yet" },
  ai_off_stalled:     { emoji: "🔴", legend: "AI off, stalled",                                 short: () => "AI off, not booked" },
  v3_only:            { emoji: "⚪", legend: "V3 only, nothing started",                        short: () => "V3 only" },
};
const LEGEND_ORDER = ["confirmed", "ai_booked_pending", "funnel_drop", "offer_not_booked", "ai_active_no_offer", "ai_off_stalled", "v3_only"];

type DaySlots = { slots: number; hours: number };
type AvailInfo = {
  openSlots: number; openHours: number; pctFree: number | null;
  // Thu/Fri/Sat availability — the days people actually book on.
  prime?: DaySlots & { thu: DaySlots; fri: DaySlots; sat: DaySlots };
  lookBusy?: { on: boolean; percentage: number };
};

function dayMeta(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export function LeadBreakdown({ ownerKey }: { ownerKey: string }) {
  const [supabase] = useState(() => createClient());
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [showLegend, setShowLegend] = useState(false);
  const [avail, setAvail] = useState<AvailInfo | null>(null);

  // Calendar availability for the next 2 weeks (open slots, hours, % free).
  useEffect(() => {
    let cancelled = false;
    setAvail(null);
    fetch(`/api/ghl/availability/${encodeURIComponent(ownerKey)}`)
      .then((r) => r.json())
      .then((j) => { if (!cancelled && j?.available) setAvail({ openSlots: j.openSlots, openHours: j.openHours, pctFree: j.pctFree, prime: j.prime, lookBusy: j.lookBusy }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [ownerKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setLoadError(false); setOpenDay(null);
    (async () => {
      // A transient network/auth blip must not render as "no lead data" when
      // the rows are sitting in the table — retry once, then show an error.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { data, error } = await supabase.from("ghl_lead_status").select("id,contact_id,location_id,contact_name,email,date_added,status,priority,ai_off,price_signal,activity_date,booked,offer_made,fanbasis")
            .eq("owner_key", ownerKey).order("priority").order("date_added", { ascending: false });
          if (cancelled) return;
          if (!error) { setLeads((data as Lead[]) ?? []); setLoading(false); return; }
        } catch { /* fetch rejected — treat like a query error and retry */ }
        if (cancelled) return;
        await new Promise((r) => setTimeout(r, 1200));
      }
      if (!cancelled) { setLoadError(true); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [supabase, ownerKey, retryTick]);

  // Changes from the Activity & Changes Log — pinned on the conversion timeline.
  const [changes, setChanges] = useState<{ action_date: string; note: string; created_by_email: string | null }[]>([]);
  useEffect(() => {
    let cancelled = false;
    setChanges([]);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 29);
    supabase.from("client_activity").select("action_date,note,created_by_email")
      .eq("client_key", ownerKey)
      .gte("action_date", cutoff.toISOString().slice(0, 10))
      .order("action_date", { ascending: true })
      .then(({ data }) => { if (!cancelled) setChanges((data as { action_date: string; note: string; created_by_email: string | null }[]) ?? []); });
    return () => { cancelled = true; };
  }, [supabase, ownerKey]);

  // Last 14 days (newest first), each with its leads (sorted by priority).
  const days = useMemo(() => {
    const out: string[] = [];
    const t = new Date();
    for (let i = 0; i < 14; i++) { const d = new Date(t); d.setDate(d.getDate() - i); out.push(d.toISOString().slice(0, 10)); }
    return out;
  }, []);
  const byDay = useMemo(() => {
    const m = new Map<string, Lead[]>();
    days.forEach((d) => m.set(d, []));
    leads.forEach((l) => {
      // Group by SIGNUP date (date_added), not last activity — so each day shows
      // who actually came in that day. Older leads sit under earlier day rows.
      const day = (l.date_added ?? "").slice(0, 10);
      const arr = m.get(day);
      if (arr) arr.push(l);
    });
    // each day's leads sorted by priority
    m.forEach((arr) => arr.sort((a, b) => a.priority - b.priority));
    return m;
  }, [leads, days]);

  // ── AI recommendation, from the last-14-day status mix ────────────────────────
  const recommendations = useMemo(() => {
    const c: Record<string, number> = {};
    let total = 0;
    let priceSignals = 0;
    byDay.forEach((arr) => arr.forEach((l) => { c[l.status] = (c[l.status] ?? 0) + 1; total++; if (l.price_signal) priceSignals++; }));
    const out: { emoji: string; title: string; body: string; steps?: string[] }[] = [];
    if (total === 0) {
      out.push({ emoji: "📉", title: "No new leads in 14 days", body: "Check the campaign is live, then consider increasing budget or broadening the audience." });
      return out;
    }
    const pct = (n: number) => Math.round((n / total) * 100);
    const v3 = c.v3_only ?? 0;
    const aiOff = c.ai_off_stalled ?? 0;
    const bookedNoDep = (c.funnel_drop ?? 0) + (c.ai_booked_pending ?? 0);
    const offerNoBook = c.offer_not_booked ?? 0;
    const activeNoOffer = c.ai_active_no_offer ?? 0;
    const confirmed = c.confirmed ?? 0;

    if (pct(v3) >= 35) out.push({ emoji: "⚪", title: "Lots of leads aren't engaging", body: `${pct(v3)}% never started a conversation. Tighten the follow-up cadence and refresh the audience/creative — these signups are going cold.` });
    if (pct(bookedNoDep) >= 25) out.push({ emoji: "📋", title: "Booking but not depositing", body: `${pct(bookedNoDep)}% picked a date/time but didn't pay the deposit — interested, not committing. Try:`, steps: [
      "Improve the audience (tighter buyer-intent targeting)",
      "Add trust factors — reviews, guarantee, credentials",
      "Test the Instagram widget (add it, or remove if it distracts)",
      "Refresh before/after photos and posted hours on the funnel",
      "Try a different deposit amount",
      "Update the offer and add urgency to claim it now",
    ] });
    if (pct(offerNoBook) >= 25) out.push({ emoji: "🔥", title: "Offers aren't converting to bookings", body: `${pct(offerNoBook)}% got an offer but didn't book. Try:`, steps: [
      "Update the offer or price",
      "Add urgency / a deadline on the special offer",
      "Check audience quality",
    ] });
    if (priceSignals >= 3) out.push({ emoji: "💸", title: "Price may be too high", body: `${priceSignals} leads got the offer, then went quiet or pushed back on price (last 14 days). Test a lower deposit/price, or build more value before showing the price.` });
    if (pct(aiOff) >= 20) out.push({ emoji: "🔴", title: "AI off and stalled", body: `${pct(aiOff)}% have AI off and went quiet. Re-enable AI or have the team follow up manually.` });
    if (pct(activeNoOffer) >= 30) out.push({ emoji: "🟡", title: "Conversations stall before the offer", body: `${pct(activeNoOffer)}% are active but no offer yet — the AI may need to present the offer sooner.` });
    if (total < 7) out.push({ emoji: "📉", title: "Low lead volume", body: `Only ${total} leads in 14 days. Consider increasing budget or broadening the audience.` });
    if (pct(confirmed) >= 15) out.push({ emoji: "✅", title: "Healthy deposit rate", body: `${pct(confirmed)}% confirmed deposits — momentum is good. Consider scaling budget while it converts.` });

    // Lots of availability but few people picking a time → it's the funnel, not the calendar.
    if (avail && avail.pctFree != null && avail.pctFree >= 50) {
      const bookingish = (c.funnel_drop ?? 0) + (c.ai_booked_pending ?? 0) + (c.confirmed ?? 0);
      if (pct(bookingish) < 15) {
        out.unshift({ emoji: "📅", title: "Calendar is wide open", body: `~${avail.openHours}h free (${avail.pctFree}% of capacity) over the next 2 weeks, but few leads are picking a time. Availability isn't the blocker — fix the funnel/offer so they choose a date.` });
      }
    }

    if (!out.length) out.push({ emoji: "👍", title: "Balanced funnel", body: "No single drop-off stands out in the last 14 days — keep the current follow-up and audience." });
    return out.slice(0, 4);
  }, [byDay, avail]);

  // ── Funnel stages, last 14 days (each stage = reached at least this far) ────
  const funnel = useMemo(() => {
    const c: Record<string, number> = {};
    let total = 0;
    // Bookings split by PATH: an "offer made" tag only comes from the AI chat,
    // so booked+offer = booked through the AI conversation, booked without an
    // offer = picked a time straight in the funnel. Works for confirmed leads
    // too (the status collapses to "confirmed" but the raw tags survive).
    // Computed over ALL leads (all time), not the 14-day window — the split is
    // a property of the account, and 14 days is too little data to trust it.
    const path = {
      funnel: { booked: 0, dep: 0 },
      ai: { booked: 0, dep: 0 },
    };
    leads.forEach((l) => {
      if (l.booked) {
        const p = l.offer_made ? path.ai : path.funnel;
        p.booked++;
        if (l.fanbasis) p.dep++;
      }
    });
    byDay.forEach((arr) => arr.forEach((l) => {
      c[l.status] = (c[l.status] ?? 0) + 1; total++;
    }));
    const engaged = total - (c.v3_only ?? 0);
    const booked = (c.funnel_drop ?? 0) + (c.ai_booked_pending ?? 0) + (c.confirmed ?? 0);
    const deposit = c.confirmed ?? 0;
    const offerNoBook = c.offer_not_booked ?? 0;
    return { total, engaged, booked, deposit, offerNoBook, path };
  }, [byDay, leads]);

  // ── Conversion trend, last 30 days ──────────────────────────────────────────
  // Rolling 7-day rates per day (cohorted by lead creation date).
  // Booked% = booked / leads. Deposit% = deposits / BOOKED leads — of the
  // people who picked a time, how many paid. (As a share of all leads the
  // number was so small the line read as broken.)
  const trend = useMemo(() => {
    const BOOKED = new Set(["funnel_drop", "ai_booked_pending", "confirmed"]);
    const dayISO = (offset: number) => { const d = new Date(); d.setDate(d.getDate() - offset); return d.toISOString().slice(0, 10); };
    const byDate = new Map<string, { n: number; booked: number; dep: number }>();
    leads.forEach((l) => {
      const d = (l.date_added ?? "").slice(0, 10);
      if (!d) return;
      const b = byDate.get(d) ?? { n: 0, booked: 0, dep: 0 };
      b.n++;
      if (BOOKED.has(l.status)) b.booked++;
      if (l.status === "confirmed") b.dep++;
      byDate.set(d, b);
    });
    const points: { date: string; n: number; book: number | null; dep: number | null }[] = [];
    for (let i = 29; i >= 0; i--) {
      let n = 0, bk = 0, dp = 0;
      for (let w = 0; w < 7; w++) {
        const d = byDate.get(dayISO(i + w));
        if (d) { n += d.n; bk += d.booked; dp += d.dep; }
      }
      points.push({ date: dayISO(i), n, book: n > 0 ? (bk / n) * 100 : null, dep: bk > 0 ? (dp / bk) * 100 : null });
    }
    return { points };
  }, [leads]);

  const emojiSummary = (arr: Lead[]) => {
    const c: Record<string, number> = {};
    arr.forEach((l) => { c[l.status] = (c[l.status] ?? 0) + 1; });
    return LEGEND_ORDER.filter((s) => c[s]).map((s) => `${STATUS[s].emoji}${c[s]}`).join(" ");
  };

  if (loading) return <div className="flex items-center gap-2 text-xs text-[#697a91] py-4"><Loader2 size={13} className="animate-spin" />Loading…</div>;
  if (loadError) return (
    <div className="text-xs text-[#8595a8] py-3">
      Couldn&apos;t load the leads (connection hiccup — the data is still there).{" "}
      <button onClick={() => setRetryTick((t) => t + 1)} className="text-[#2563eb] underline underline-offset-2">Retry</button>
    </div>
  );
  if (!leads.length) return <div className="text-xs text-[#8595a8] py-3">No V3 lead data ingested for this client yet.</div>;

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4 md:items-start">
      {/* Funnel + AI recommendation (right on desktop) */}
      {/* On wide screens the three analysis boxes sit side by side */}
      <div className="min-w-0 md:order-2 space-y-2 xl:col-span-3 xl:grid xl:grid-cols-3 xl:gap-3 xl:items-start xl:space-y-0">
      {funnel.total > 0 && (() => {
        // Ordered the way the client journey actually runs: everyone signs up
        // as a lead, some book a time right away, the rest we chase in chat
        // (so "engaged" counts booked AND not-booked), and finally deposits.
        // Steps aren't nested (more leads engage than book) — each connector
        // carries its own comparison instead of a blind "% continue".
        const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
        const stages: { emoji: string; label: string; n: number; color: string; conn: { pct: number; text: string; lost: number; lostText: string } | null }[] = [
          { emoji: "🆕", label: "New leads", n: funnel.total, color: "#15B7AE", conn: null },
          { emoji: "📅", label: "Booked a time", n: funnel.booked, color: "#34568a",
            conn: { pct: pct(funnel.booked, funnel.total), text: "booked a time", lost: funnel.total - funnel.booked, lostText: "didn't book" } },
          { emoji: "💬", label: "Engaged in conversation", n: funnel.engaged, color: "#2d8fa0",
            conn: { pct: pct(funnel.engaged, funnel.total), text: "of all leads engaged (booked or not)", lost: funnel.total - funnel.engaged, lostText: "never engaged" } },
          { emoji: "💰", label: "Paid deposit", n: funnel.deposit, color: "#15803d",
            conn: { pct: pct(funnel.deposit, funnel.engaged), text: "of engaged paid", lost: funnel.engaged - funnel.deposit, lostText: "engaged but never paid" } },
        ];
        // Biggest leak = the connector losing the most leads.
        let leakIdx = -1, leakMax = 0;
        stages.forEach((s, i) => { if (s.conn && s.conn.lost > leakMax) { leakMax = s.conn.lost; leakIdx = i; } });
        const pctOf = (n: number) => pct(n, funnel.total);
        return (
          <div className="rounded-lg border border-[#e4ebf2] bg-white p-2.5">
            <div className="text-[11px] font-bold uppercase tracking-wide text-[#34568a] mb-2">
              🪜 Lead funnel <span className="font-medium normal-case text-[#697a91] tracking-normal">· last 14 days</span>
            </div>
            <div className="space-y-0.5">
              {stages.map((s, i) => {
                // Health check on the booking step: below 35% booked is under target.
                const isBookStep = s.label === "Booked a time";
                const unhealthyBooking = isBookStep && s.conn != null && s.conn.pct < HEALTHY_BOOK_PCT;
                return (
                  <div key={s.label}>
                    {s.conn && (
                      <div className={`flex items-center gap-1.5 pl-1 py-0.5 text-[10px] flex-wrap ${i === leakIdx || unhealthyBooking ? "text-[#e11d48] font-bold" : "text-[#8595a8]"}`}>
                        <span>↓ {s.conn.pct}% {s.conn.text}{s.conn.lost > 0 ? ` · ${s.conn.lost} ${s.conn.lostText}` : ""}</span>
                        {unhealthyBooking && (
                          <span className="px-1.5 py-0.5 rounded bg-[#fde8ee] border border-[#f5c2cf] leading-none">🚨 below healthy ({HEALTHY_BOOK_PCT}%+)</span>
                        )}
                        {isBookStep && s.conn.pct >= HEALTHY_BOOK_PCT && (
                          <span className="px-1.5 py-0.5 rounded bg-[#e7f6ec] border border-[#bfe3cd] text-[#15803d] font-semibold leading-none">✓ healthy</span>
                        )}
                        {i === leakIdx && s.conn.lost > 0 && (
                          <span className="px-1.5 py-0.5 rounded bg-[#fde8ee] border border-[#f5c2cf] leading-none">⚠ biggest leak — stuck here</span>
                        )}
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-2 text-[11px] text-[#1f3559]">
                      <span className="font-semibold whitespace-nowrap">{s.emoji} {s.label}</span>
                      <span className="text-[#697a91] whitespace-nowrap">{s.n} · <strong className="text-[#1f3559]">{pctOf(s.n)}%</strong></span>
                    </div>
                    <div className="h-3.5 rounded bg-[#f1f5f9] overflow-hidden">
                      <div className="h-full rounded transition-all" style={{ width: `${Math.max(pctOf(s.n), s.n > 0 ? 4 : 0)}%`, background: s.color }} />
                    </div>
                  </div>
                );
              })}
            </div>
            {funnel.offerNoBook > 0 && (
              <p className="mt-1.5 text-[10px] text-[#8595a8]">🔥 {funnel.offerNoBook} more got an offer in chat but never booked a time.</p>
            )}
            {(funnel.path.funnel.booked > 0 || funnel.path.ai.booked > 0) && (() => {
              // Which path books better AND which converts its bookings to money.
              const rows = [
                { emoji: "📋", label: "Through the funnel", ...funnel.path.funnel },
                { emoji: "🤖", label: "Through the AI chat", ...funnel.path.ai },
              ].map((r) => ({ ...r, rate: r.booked > 0 ? Math.round((r.dep / r.booked) * 100) : null }));
              const best = rows[0].rate != null && rows[1].rate != null && rows[0].rate !== rows[1].rate
                ? (rows[0].rate > rows[1].rate ? 0 : 1) : -1;
              return (
                <div className="mt-2 pt-2 border-t border-[#eef3f8]">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-[#34568a] mb-1">📅 Where the bookings come from <span className="font-medium normal-case text-[#697a91] tracking-normal">· all time</span></div>
                  {rows.map((r, i) => (
                    <div key={r.label} className="flex items-center justify-between gap-2 text-[11px] text-[#1f3559] py-0.5">
                      <span className="whitespace-nowrap">{r.emoji} {r.label}</span>
                      <span className="text-[#697a91] whitespace-nowrap">
                        <strong className="text-[#1f3559]">{r.booked}</strong> booked · {r.dep} paid{r.rate != null ? ` (${r.rate}%)` : ""}
                        {best === i && <span className="ml-1 px-1 py-0.5 rounded bg-[#e7f6ec] border border-[#bfe3cd] text-[#15803d] text-[9px] font-bold">converts better</span>}
                      </span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        );
      })()}
      {recommendations.length > 0 && (
        <div className="rounded-lg border border-[#bfe9e5] bg-gradient-to-br from-[#f0fbfa] to-[#eef4ff] p-2.5 space-y-2">
          <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-[#0e8f88]">
            <Sparkles size={12} /> AI Recommendation <span className="font-medium normal-case text-[#697a91] tracking-normal">· last 14 days</span>
          </div>
          {avail && (
            <div className="text-[11px] text-[#34568a] space-y-0.5">
              {avail.prime && (
                <div>
                  🔥 <span className="font-semibold">Thu–Sat (when people book):</span> {avail.prime.slots} open slots · ~{avail.prime.hours}h
                  <span className="text-[#697a91]"> — Thu {avail.prime.thu.slots} (~{avail.prime.thu.hours}h) · Fri {avail.prime.fri.slots} (~{avail.prime.fri.hours}h) · Sat {avail.prime.sat.slots} (~{avail.prime.sat.hours}h)</span>
                </div>
              )}
              <div>📅 <span className="font-semibold">Next 2 weeks:</span> {avail.openSlots} open slots · ~{avail.openHours}h{avail.pctFree != null ? ` · ${avail.pctFree}% free` : ""}</div>
              {avail.lookBusy && (
                avail.lookBusy.on ? (
                  <div className="text-[#d97706]">⚠️ &ldquo;Look Busy&rdquo; is ON ({avail.lookBusy.percentage}%) — leads only see ~{100 - avail.lookBusy.percentage}% of this. Turn it off if availability is tight.</div>
                ) : (
                  <div className="text-[#0e8f88]">✅ &ldquo;Look Busy&rdquo; is off — leads see all open times.</div>
                )
              )}
            </div>
          )}
          {recommendations.map((r, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className="text-sm leading-none mt-0.5">{r.emoji}</span>
              <div>
                <p className="text-xs font-semibold text-[#1f3559]">{r.title}</p>
                <p className="text-[11px] text-[#56678a] leading-snug">{r.body}</p>
                {r.steps && (
                  <ul className="mt-1 space-y-0.5">
                    {r.steps.map((s, j) => (
                      <li key={j} className="flex gap-1.5 text-[11px] text-[#56678a] leading-snug">
                        <span className="text-[#0e8f88]">•</span>{s}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Conversion timeline — rolling 7-day rates over the last 30 days,
          with the Activity & Changes Log entries pinned at their dates. */}
      {trend.points.some((p) => p.n > 0) && (() => {
        const W = 292, H = 52, X0 = 4, Y0 = 16;
        // Group logged changes by date and map onto timeline positions.
        const dateIdx = new Map(trend.points.map((p, i) => [p.date, i]));
        const pinGroups: { date: string; idx: number; notes: string[]; num: number }[] = [];
        for (const c of changes) {
          const idx = dateIdx.get(c.action_date);
          if (idx == null) continue;
          // Include the author so it's clear who made each change.
          const who = c.created_by_email ? c.created_by_email.split("@")[0] : "";
          const label = who ? `${c.note} (${who.charAt(0).toUpperCase() + who.slice(1)})` : c.note;
          const g = pinGroups.find((p) => p.date === c.action_date);
          if (g) g.notes.push(label);
          else pinGroups.push({ date: c.action_date, idx, notes: [label], num: pinGroups.length + 1 });
        }
        const vals = trend.points.flatMap((p) => [p.book, p.dep]).filter((v): v is number => v != null);
        const yMax = Math.max(10, Math.ceil(Math.max(...vals, 0) / 10) * 10);
        const px = (i: number) => X0 + (i * W) / (trend.points.length - 1);
        const py = (v: number) => Y0 + H - (v / yMax) * H;
        const path = (key: "book" | "dep") => {
          let d = "", pen = false;
          trend.points.forEach((p, i) => {
            const v = p[key];
            if (v == null) { pen = false; return; }
            d += `${pen ? "L" : "M"}${px(i).toFixed(1)},${py(v).toFixed(1)}`;
            pen = true;
          });
          return d;
        };
        const lastVal = (key: "book" | "dep") => {
          for (let i = trend.points.length - 1; i >= 0; i--) { const v = trend.points[i][key]; if (v != null) return v; }
          return null;
        };
        const fmtD = (iso: string) => new Date(iso + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
        const bookNow = lastVal("book"), depNow = lastVal("dep");
        return (
          <div className="rounded-lg border border-[#e4ebf2] bg-white p-2.5">
            <div className="text-[11px] font-bold uppercase tracking-wide text-[#34568a]">
              📈 Conversion timeline <span className="font-medium normal-case text-[#697a91] tracking-normal">· last 30 days · 📌 = logged change</span>
            </div>
            <div className="mt-1 flex items-center gap-3 flex-wrap text-[11px]">
              <span><span className="inline-block w-2.5 h-[3px] rounded align-middle mr-1" style={{ background: "#34568a" }} />📅 Booked {bookNow == null ? "—" : `${Math.round(bookNow)}%`} <span className="text-[#8595a8]">of leads</span></span>
              <span><span className="inline-block w-2.5 h-[3px] rounded align-middle mr-1" style={{ background: "#15803d" }} />💰 Deposit {depNow == null ? "—" : `${Math.round(depNow)}%`} <span className="text-[#8595a8]">of booked</span></span>
            </div>
            <svg viewBox="0 0 300 84" className="w-full mt-1" role="img" aria-label="Booking and deposit conversion trend, last 30 days">
              {[0, 0.5, 1].map((f) => (
                <g key={f}>
                  <line x1={X0} x2={X0 + W} y1={Y0 + H - f * H} y2={Y0 + H - f * H} stroke="#eef3f8" strokeWidth={1} />
                  <text x={X0 + W} y={Y0 + H - f * H - 2} fontSize={7} fill="#a6b3c4" textAnchor="end">{Math.round(f * yMax)}%</text>
                </g>
              ))}
              <path d={path("book")} fill="none" stroke="#34568a" strokeWidth={1.8} strokeLinecap="round" />
              <path d={path("dep")} fill="none" stroke="#15803d" strokeWidth={1.8} strokeLinecap="round" />
              {pinGroups.map((g) => (
                <g key={g.date}>
                  <title>{`${fmtD(g.date)} — ${g.notes.join(" · ")}`}</title>
                  <line x1={px(g.idx)} x2={px(g.idx)} y1={Y0 - 2} y2={Y0 + H} stroke="#ea580c" strokeWidth={1} strokeDasharray="2 2" />
                  <circle cx={px(g.idx)} cy={8} r={5.5} fill="#ea580c" />
                  <text x={px(g.idx)} y={10.5} fontSize={7} fill="#ffffff" textAnchor="middle" fontWeight="bold">{g.num}</text>
                </g>
              ))}
              <text x={X0} y={80} fontSize={7.5} fill="#8595a8">{fmtD(trend.points[0].date)}</text>
              <text x={X0 + W} y={80} fontSize={7.5} fill="#8595a8" textAnchor="end">{fmtD(trend.points[trend.points.length - 1].date)}</text>
            </svg>
            {pinGroups.length > 0 ? (
              <ul className="mt-1 space-y-0.5">
                {pinGroups.map((g) => (
                  <li key={g.date} className="flex items-start gap-1.5 text-[11px] leading-snug">
                    <span className="shrink-0 mt-[1px] w-4 h-4 rounded-full bg-[#ea580c] text-white text-[9px] font-bold flex items-center justify-center">{g.num}</span>
                    <span className="text-[#34568a]"><strong className="text-[#1f3559]">{fmtD(g.date)}</strong> — {g.notes.join(" · ")}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-[10px] text-[#8595a8]">No changes logged in this window — add them in the <strong>Activity &amp; Changes Log</strong> below and they&apos;ll show as 📌 pins on the timeline.</p>
            )}
          </div>
        );
      })()}
      </div>

      {/* Legend + 14-day list (left on desktop) */}
      <div className="space-y-2 min-w-0 md:order-1">
      <button onClick={() => setShowLegend((s) => !s)} className="text-[11px] font-medium text-[#0e8f88] hover:underline">
        {showLegend ? "Hide legend" : "Show legend"}
      </button>
      {showLegend && (
        <div className="rounded-lg bg-[#f7fafc] border border-[#eef3f8] p-2.5 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
          {LEGEND_ORDER.map((s) => (
            <div key={s} className="flex items-center gap-1.5 text-xs text-[#34568a]"><span>{STATUS[s].emoji}</span>{STATUS[s].legend}</div>
          ))}
        </div>
      )}

      {/* 14-day accordion */}
      <ul className="rounded-lg border border-[#eef3f8] divide-y divide-[#f1f5f9] overflow-hidden">
        {days.map((d) => {
          const arr = byDay.get(d) ?? [];
          const open = openDay === d;
          return (
            <li key={d}>
              <button onClick={() => setOpenDay(open ? null : d)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${open ? "bg-[#eef7f6]" : "hover:bg-[#fafcfe]"} ${arr.length ? "" : "opacity-60"}`}>
                <ChevronRight size={13} className={`text-[#94a3b8] transition-transform ${open ? "rotate-90" : ""}`} />
                <span className="text-sm font-medium text-[#1f3559] w-[120px] shrink-0">{dayMeta(d)}</span>
                <span className="text-xs text-[#697a91] shrink-0">{arr.length} {arr.length === 1 ? "lead" : "leads"}</span>
                <span className="ml-auto text-xs tracking-wide truncate">{emojiSummary(arr)}</span>
              </button>
              {open && (
                <div className="px-3 pb-2.5 pt-0.5 bg-[#fcfdfe]">
                  {arr.length === 0 ? (
                    <p className="text-xs text-[#8595a8] py-1.5">No new leads this day.</p>
                  ) : (
                    <ul className="space-y-1">
                      {arr.map((l) => {
                        const cfg = STATUS[l.status];
                        return (
                          <li key={l.id} className="flex items-center gap-2 text-sm flex-wrap">
                            <span title={cfg.legend}>{cfg.emoji}</span>
                            <span className="font-medium text-[#1f3559]">{l.contact_name || l.email || "—"}</span>
                            {l.contact_id && l.location_id && (
                              <a href={`https://app.gohighlevel.com/v2/location/${l.location_id}/conversations/conversations/${l.contact_id}`}
                                target="_blank" rel="noreferrer"
                                title="Open this lead's conversation in GoHighLevel"
                                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[10px] font-semibold border bg-white text-[#0e8f88] border-[#a7e3df] hover:bg-[#e6f7f5]">
                                <MessageCircle size={10} /> chat
                              </a>
                            )}
                            <span className="text-[#697a91]">— {cfg.short(l.ai_off)}</span>
                            {l.price_signal === "silent" && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#fff1e8] text-[#ea580c] border border-[#fed0b0]" title="Got the offer (knows the price), then stopped replying — possible price pushback">🔇 silent after offer</span>
                            )}
                            {l.price_signal === "objection" && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#fde8ee] text-[#e11d48] border border-[#f5c2cf]" title="Mentioned cost/price concern after the offer">💸 too expensive</span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      </div>
    </div>
  );
}
