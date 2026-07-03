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
      const day = (l.activity_date ?? l.date_added ?? "").slice(0, 10);
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
    byDay.forEach((arr) => arr.forEach((l) => { c[l.status] = (c[l.status] ?? 0) + 1; total++; }));
    const engaged = total - (c.v3_only ?? 0);
    const booked = (c.funnel_drop ?? 0) + (c.ai_booked_pending ?? 0) + (c.confirmed ?? 0);
    const deposit = c.confirmed ?? 0;
    const offerNoBook = c.offer_not_booked ?? 0;
    return { total, engaged, booked, deposit, offerNoBook };
  }, [byDay]);

  const emojiSummary = (arr: Lead[]) => {
    const c: Record<string, number> = {};
    arr.forEach((l) => { c[l.status] = (c[l.status] ?? 0) + 1; });
    return LEGEND_ORDER.filter((s) => c[s]).map((s) => `${STATUS[s].emoji}${c[s]}`).join(" ");
  };

  if (loading) return <div className="flex items-center gap-2 text-xs text-[#697a91] py-4"><Loader2 size={13} className="animate-spin" />Loading…</div>;
  if (!leads.length) return <div className="text-xs text-[#8595a8] py-3">No V3 lead data ingested for this client yet.</div>;

  return (
    <div className="grid gap-3 md:grid-cols-2 md:items-start">
      {/* Funnel + AI recommendation (right on desktop) */}
      <div className="space-y-2 min-w-0 md:order-2">
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
      </div>
    </div>
  );
}
