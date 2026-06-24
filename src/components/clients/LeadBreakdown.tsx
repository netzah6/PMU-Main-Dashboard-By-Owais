"use client";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Loader2, ChevronRight } from "lucide-react";

interface Lead {
  id: string;
  contact_name: string | null;
  email: string | null;
  date_added: string | null;
  status: string;
  priority: number;
  ai_off: boolean;
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

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setOpenDay(null);
    (async () => {
      const { data } = await supabase.from("ghl_lead_status").select("id,contact_name,email,date_added,status,priority,ai_off")
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
      const day = (l.date_added ?? "").slice(0, 10);
      const arr = m.get(day);
      if (arr) arr.push(l);
    });
    // each day's leads sorted by priority
    m.forEach((arr) => arr.sort((a, b) => a.priority - b.priority));
    return m;
  }, [leads, days]);

  const emojiSummary = (arr: Lead[]) => {
    const c: Record<string, number> = {};
    arr.forEach((l) => { c[l.status] = (c[l.status] ?? 0) + 1; });
    return LEGEND_ORDER.filter((s) => c[s]).map((s) => `${STATUS[s].emoji}${c[s]}`).join(" ");
  };

  if (loading) return <div className="flex items-center gap-2 text-xs text-[#697a91] py-4"><Loader2 size={13} className="animate-spin" />Loading…</div>;
  if (!leads.length) return <div className="text-xs text-[#8595a8] py-3">No V3 lead data ingested for this client yet.</div>;

  return (
    <div className="space-y-2">
      {/* Legend toggle */}
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
                          <li key={l.id} className="flex items-center gap-2 text-sm">
                            <span title={cfg.legend}>{cfg.emoji}</span>
                            <span className="font-medium text-[#1f3559]">{l.contact_name || l.email || "—"}</span>
                            <span className="text-[#697a91]">— {cfg.short(l.ai_off)}</span>
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
  );
}
