"use client";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Loader2, ChevronRight, Sparkles } from "lucide-react";

interface Lead {
  id: string;
  contact_name: string | null;
  email: string | null;
  date_added: string | null;
  status: string;
  priority: number;
  ai_off: boolean;
  price_signal: string | null;
  activity_date: string | null;
}

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

function dayMeta(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export function LeadBreakdown({ ownerKey }: { ownerKey: string }) {
  const [supabase] = useState(() => createClient());
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [showLegend, setShowLegend] = useState(false);
  const [avail, setAvail] = useState<{ openSlots: number; openHours: number; pctFree: number | null; lookBusy?: { on: boolean; percentage: number } } | null>(null);

  // Calendar availability for the next 2 weeks (open slots, hours, % free).
  useEffect(() => {
    let cancelled = false;
    setAvail(null);
    fetch(`/api/ghl/availability/${encodeURIComponent(ownerKey)}`)
      .then((r) => r.json())
      .then((j) => { if (!cancelled && j?.available) setAvail({ openSlots: j.openSlots, openHours: j.openHours, pctFree: j.pctFree, lookBusy: j.lookBusy }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [ownerKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setOpenDay(null);
    (async () => {
      const { data } = await supabase.from("ghl_lead_status").select("id,contact_name,email,date_added,status,priority,ai_off,price_signal,activity_date")
        .eq("owner_key", ownerKey).order("priority").order("date_added", { ascending: false });
      if (!cancelled) { setLeads((data as Lead[]) ?? []); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [supabase, ownerKey]);

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

  // ── Older signups still in conversation ──────────────────────────────────────
  // Grouping by signup date hides leads who signed up 15+ days ago but are STILL
  // actively in an AI conversation (their status matters but their signup-day row
  // is off the bottom of the 14-day list). Surface those here so no live
  // conversation is lost: engaged (not "v3_only") + last activity within 14 days +
  // signup outside the visible day window.
  const stillActive = useMemo(() => {
    const daySet = new Set(days);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 13);
    const cutoffISO = cutoff.toISOString().slice(0, 10);
    return leads
      .filter((l) => {
        const signup = (l.date_added ?? "").slice(0, 10);
        if (!signup || daySet.has(signup)) return false; // already in the day list
        if (l.status === "v3_only") return false;        // never engaged — skip
        const act = (l.activity_date ?? "").slice(0, 10);
        return act >= cutoffISO;                          // active in the last 14 days
      })
      .sort((a, b) => (b.activity_date ?? "").localeCompare(a.activity_date ?? ""));
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
    byDay.forEach((arr) => arr.forEach((l) => { c[l.status] = (c[l.status] ?? 0) + 1; total++; }));
    const engaged = total - (c.v3_only ?? 0);
    const booked = (c.funnel_drop ?? 0) + (c.ai_booked_pending ?? 0) + (c.confirmed ?? 0);
    const deposit = c.confirmed ?? 0;
    const offerNoBook = c.offer_not_booked ?? 0;
    return { total, engaged, booked, deposit, offerNoBook };
  }, [byDay]);

  // ── Conversion trend, last 30 days ──────────────────────────────────────────
  // Rolling 7-day booking% / deposit% per day (cohorted by lead creation date),
  // plus last-14-days vs the 14 before for a clean "are we improving" readout.
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
      points.push({ date: dayISO(i), n, book: n > 0 ? (bk / n) * 100 : null, dep: n > 0 ? (dp / n) * 100 : null });
    }
    const agg = (from: number, to: number) => {
      let n = 0, bk = 0, dp = 0;
      for (let i = from; i <= to; i++) { const d = byDate.get(dayISO(i)); if (d) { n += d.n; bk += d.booked; dp += d.dep; } }
      return { n, book: n > 0 ? (bk / n) * 100 : null, dep: n > 0 ? (dp / n) * 100 : null };
    };
    return { points, cur: agg(0, 13), prev: agg(14, 27) };
  }, [leads]);

  const emojiSummary = (arr: Lead[]) => {
    const c: Record<string, number> = {};
    arr.forEach((l) => { c[l.status] = (c[l.status] ?? 0) + 1; });
    return LEGEND_ORDER.filter((s) => c[s]).map((s) => `${STATUS[s].emoji}${c[s]}`).join(" ");
  };

  if (loading) return <div className="flex items-center gap-2 text-xs text-[#697a91] py-4"><Loader2 size={13} className="animate-spin" />Loading…</div>;
  if (!leads.length) return <div className="text-xs text-[#8595a8] py-3">No V3 lead data ingested for this client yet.</div>;

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4 md:items-start">
      {/* Funnel + AI recommendation (right on desktop) */}
      {/* On wide screens the three analysis boxes sit side by side */}
      <div className="min-w-0 md:order-2 space-y-2 xl:col-span-3 xl:grid xl:grid-cols-3 xl:gap-3 xl:items-start xl:space-y-0">
      {funnel.total > 0 && (() => {
        const stages = [
          { emoji: "🆕", label: "New leads", n: funnel.total, color: "#15B7AE" },
          { emoji: "💬", label: "Engaged in conversation", n: funnel.engaged, color: "#2d8fa0" },
          { emoji: "📅", label: "Booked a time", n: funnel.booked, color: "#34568a" },
          { emoji: "💰", label: "Paid deposit", n: funnel.deposit, color: "#15803d" },
        ];
        // Biggest leak = largest number of leads lost between consecutive stages.
        let leakIdx = -1, leakMax = 0;
        for (let i = 1; i < stages.length; i++) {
          const lost = stages[i - 1].n - stages[i].n;
          if (lost > leakMax) { leakMax = lost; leakIdx = i; }
        }
        const pctOf = (n: number) => Math.round((n / funnel.total) * 100);
        return (
          <div className="rounded-lg border border-[#e4ebf2] bg-white p-2.5">
            <div className="text-[11px] font-bold uppercase tracking-wide text-[#34568a] mb-2">
              🪜 Lead funnel <span className="font-medium normal-case text-[#697a91] tracking-normal">· last 14 days</span>
            </div>
            <div className="space-y-0.5">
              {stages.map((s, i) => {
                const step = i > 0 ? (stages[i - 1].n > 0 ? Math.round((s.n / stages[i - 1].n) * 100) : 0) : null;
                const lost = i > 0 ? stages[i - 1].n - s.n : 0;
                return (
                  <div key={s.label}>
                    {i > 0 && (
                      <div className={`flex items-center gap-1.5 pl-1 py-0.5 text-[10px] ${i === leakIdx ? "text-[#e11d48] font-bold" : "text-[#8595a8]"}`}>
                        <span>↓ {step}% continue{lost > 0 ? ` · ${lost} lost` : ""}</span>
                        {i === leakIdx && lost > 0 && (
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
        const Delta = ({ cur, prev }: { cur: number | null; prev: number | null }) => {
          if (cur == null || prev == null) return <span className="text-[#a6b3c4]">—</span>;
          const pp = Math.round(cur - prev);
          if (pp === 0) return <span className="text-[#8595a8]">→ flat</span>;
          return <span className={pp > 0 ? "text-[#15803d] font-bold" : "text-[#e11d48] font-bold"}>{pp > 0 ? "▲" : "▼"} {pp > 0 ? "+" : ""}{pp}pp</span>;
        };
        const bookNow = lastVal("book"), depNow = lastVal("dep");
        return (
          <div className="rounded-lg border border-[#e4ebf2] bg-white p-2.5">
            <div className="text-[11px] font-bold uppercase tracking-wide text-[#34568a]">
              📈 Conversion timeline <span className="font-medium normal-case text-[#697a91] tracking-normal">· last 30 days · 📌 = logged change</span>
            </div>
            <div className="mt-1 flex items-center gap-3 flex-wrap text-[11px]">
              <span><span className="inline-block w-2.5 h-[3px] rounded align-middle mr-1" style={{ background: "#34568a" }} />📅 Booked {bookNow == null ? "—" : `${Math.round(bookNow)}%`}</span>
              <span><span className="inline-block w-2.5 h-[3px] rounded align-middle mr-1" style={{ background: "#15803d" }} />💰 Deposit {depNow == null ? "—" : `${Math.round(depNow)}%`}</span>
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
            <div className="mt-1 rounded bg-[#f7fafc] border border-[#eef3f8] px-2 py-1.5 text-[11px] text-[#34568a] space-y-0.5">
              <div className="font-semibold text-[#1f3559]">Last 14 days vs the 14 before:</div>
              <div>📅 Booked: {trend.cur.book == null ? "—" : `${Math.round(trend.cur.book)}%`} vs {trend.prev.book == null ? "—" : `${Math.round(trend.prev.book)}%`} <Delta cur={trend.cur.book} prev={trend.prev.book} /></div>
              <div>💰 Deposit: {trend.cur.dep == null ? "—" : `${Math.round(trend.cur.dep)}%`} vs {trend.prev.dep == null ? "—" : `${Math.round(trend.prev.dep)}%`} <Delta cur={trend.cur.dep} prev={trend.prev.dep} /></div>
              <div className="text-[#697a91]">Leads: {trend.cur.n} vs {trend.prev.n}</div>
            </div>
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

      {/* Older signups still in active conversation — hidden by the signup-date
          window above, surfaced here so no live conversation gets lost. */}
      {stillActive.length > 0 && (
        <div className="rounded-lg border border-[#cdeae0] bg-[#f3fbf7] overflow-hidden">
          <div className="px-3 py-2 flex items-center gap-2 border-b border-[#dcefe6]">
            <span className="text-sm">💬</span>
            <span className="text-[11px] font-bold uppercase tracking-wide text-[#0e8f88]">Older signups still in conversation</span>
            <span className="ml-auto text-[10px] text-[#697a91] whitespace-nowrap">{stillActive.length} active · signed up 15+ days ago</span>
          </div>
          <ul className="divide-y divide-[#e6f3ec]">
            {stillActive.map((l) => {
              const cfg = STATUS[l.status];
              return (
                <li key={l.id} className="flex items-center gap-2 text-sm flex-wrap px-3 py-1.5">
                  <span title={cfg.legend}>{cfg.emoji}</span>
                  <span className="font-medium text-[#1f3559]">{l.contact_name || l.email || "—"}</span>
                  <span className="text-[#697a91]">— {cfg.short(l.ai_off)}</span>
                  {l.price_signal === "silent" && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#fff1e8] text-[#ea580c] border border-[#fed0b0]" title="Got the offer (knows the price), then stopped replying — possible price pushback">🔇 silent after offer</span>
                  )}
                  {l.price_signal === "objection" && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#fde8ee] text-[#e11d48] border border-[#f5c2cf]" title="Mentioned cost/price concern after the offer">💸 too expensive</span>
                  )}
                  <span className="ml-auto text-[10px] text-[#8595a8] whitespace-nowrap">signed up {dayMeta((l.date_added ?? "").slice(0, 10))} · active {dayMeta((l.activity_date ?? "").slice(0, 10))}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      </div>
    </div>
  );
}
