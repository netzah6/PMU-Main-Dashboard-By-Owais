"use client";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Loader2, Sparkles } from "lucide-react";

interface Lead {
  id: string;
  contact_id: string | null;
  contact_name: string | null;
  email: string | null;
  date_added: string | null;
  status: string;
  priority: number;
  ai_off: boolean;
  ai_on: boolean;
}
interface Convo { contact_id: string; last_message_body: string | null; last_message_date: string | null; last_message_direction: string | null }

const STATUS: Record<string, { emoji: string; label: string; color: string; bg: string }> = {
  offer_not_booked:   { emoji: "🔥", label: "Offer made, not booked", color: "#c2410c", bg: "#fff1e6" },
  ai_booked_pending:  { emoji: "🤖", label: "AI booked, deposit pending", color: "#185fa5", bg: "#e6f1fb" },
  funnel_drop:        { emoji: "📋", label: "Funnel drop, no AI yet", color: "#6d28d9", bg: "#f1ebfd" },
  confirmed:          { emoji: "✅", label: "Confirmed + deposit", color: "#15803d", bg: "#e7f7ee" },
  ai_active_no_offer: { emoji: "🟡", label: "AI active, no offer yet", color: "#b45309", bg: "#fef6e0" },
  ai_off_stalled:     { emoji: "🔴", label: "AI off, stalled", color: "#b91c1c", bg: "#fdecec" },
  v3_only:            { emoji: "⚪", label: "V3 only, nothing started", color: "#64748b", bg: "#f1f5f9" },
};
const ORDER = ["offer_not_booked", "ai_booked_pending", "funnel_drop", "confirmed", "ai_active_no_offer", "ai_off_stalled", "v3_only"];

function fmtDate(s: string | null) {
  if (!s) return "";
  const d = new Date(s);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function dayLabel(iso: string) {
  const [, m, d] = iso.split("-");
  return `${Number(m)}/${Number(d)}`;
}

export function LeadBreakdown({ ownerKey }: { ownerKey: string }) {
  const [supabase] = useState(() => createClient());
  const [leads, setLeads] = useState<Lead[]>([]);
  const [convos, setConvos] = useState<Map<string, Convo>>(new Map());
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string | null>(null);
  const [dayFilter, setDayFilter] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setFilter(null); setDayFilter(null);
    (async () => {
      const { data: ls } = await supabase.from("ghl_lead_status").select("*").eq("owner_key", ownerKey).order("priority").order("date_added", { ascending: false });
      const leadRows = (ls as Lead[]) ?? [];
      const ids = leadRows.map((l) => l.contact_id).filter(Boolean) as string[];
      let cmap = new Map<string, Convo>();
      if (ids.length) {
        const { data: cv } = await supabase.from("ghl_conversations").select("contact_id,last_message_body,last_message_date,last_message_direction").in("contact_id", ids);
        cmap = new Map(((cv as Convo[]) ?? []).map((c) => [c.contact_id, c]));
      }
      if (!cancelled) { setLeads(leadRows); setConvos(cmap); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [supabase, ownerKey]);

  // Last 14 days (local), each with per-status counts of leads added that day.
  const days = useMemo(() => {
    const out: string[] = [];
    const t = new Date();
    for (let i = 13; i >= 0; i--) { const d = new Date(t); d.setDate(d.getDate() - i); out.push(d.toISOString().slice(0, 10)); }
    return out;
  }, []);
  const byDay = useMemo(() => {
    const m = new Map<string, Record<string, number>>();
    days.forEach((d) => m.set(d, {}));
    leads.forEach((l) => {
      const day = (l.date_added ?? "").slice(0, 10);
      const rec = m.get(day);
      if (rec) rec[l.status] = (rec[l.status] ?? 0) + 1;
    });
    return m;
  }, [leads, days]);
  const dayTotal = (d: string) => Object.values(byDay.get(d) ?? {}).reduce((a, b) => a + b, 0);
  const maxDay = Math.max(1, ...days.map(dayTotal));
  const last14Total = days.reduce((a, d) => a + dayTotal(d), 0);

  const viewLeads = useMemo(() => (dayFilter ? leads.filter((l) => (l.date_added ?? "").slice(0, 10) === dayFilter) : leads), [leads, dayFilter]);
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    viewLeads.forEach((l) => { m[l.status] = (m[l.status] ?? 0) + 1; });
    return m;
  }, [viewLeads]);
  const shown = useMemo(() => (filter ? viewLeads.filter((l) => l.status === filter) : viewLeads), [viewLeads, filter]);

  if (loading) return <div className="flex items-center gap-2 text-xs text-[#697a91] py-4"><Loader2 size={13} className="animate-spin" />Loading leads…</div>;
  if (!leads.length) return <div className="text-xs text-[#8595a8] py-3">No V3 lead data ingested for this client yet.</div>;

  return (
    <div className="space-y-3">
      {/* 14-day daily chart (stacked by status) */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold text-[#34568a]">Last 14 days · {last14Total} new leads</span>
          {dayFilter && <button onClick={() => setDayFilter(null)} className="text-[11px] text-[#0e8f88] hover:underline">Show all</button>}
        </div>
        <div className="flex items-end gap-[3px] h-[70px]">
          {days.map((d) => {
            const rec = byDay.get(d) ?? {};
            const total = dayTotal(d);
            const sel = dayFilter === d;
            return (
              <button key={d} onClick={() => setDayFilter(sel ? null : d)} title={`${d} · ${total} leads`}
                className="flex-1 flex flex-col justify-end items-stretch group relative"
                style={{ height: "100%", opacity: dayFilter && !sel ? 0.5 : 1 }}>
                <div className="flex flex-col-reverse rounded-t-sm overflow-hidden border border-transparent group-hover:border-[#15B7AE]" style={{ height: `${(total / maxDay) * 100}%`, minHeight: total ? 3 : 0 }}>
                  {ORDER.filter((s) => rec[s]).map((s) => (
                    <div key={s} style={{ background: STATUS[s].color, flex: rec[s] }} />
                  ))}
                </div>
                <span className="text-[8px] text-[#8595a8] mt-0.5 text-center">{dayLabel(d)}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Status chips (reflect the selected day, or all) */}
      <div className="flex flex-wrap gap-1.5">
        {ORDER.filter((s) => counts[s]).map((s) => {
          const cfg = STATUS[s];
          const on = filter === s;
          return (
            <button key={s} onClick={() => setFilter(on ? null : s)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all"
              style={{ background: cfg.bg, color: cfg.color, borderColor: on ? cfg.color : "transparent", opacity: filter && !on ? 0.5 : 1 }}
              title={cfg.label}>
              <span>{cfg.emoji}</span>{cfg.label}
              <span className="px-1.5 py-0.5 rounded-full bg-white/70 text-[10px]">{counts[s]}</span>
            </button>
          );
        })}
        <span className="ml-auto text-xs text-[#697a91] self-center">
          {dayFilter ? `${fmtDate(dayFilter)} · ${viewLeads.length}` : `${leads.length}`} leads
        </span>
      </div>

      {/* Lead list */}
      <ul className="rounded-lg border border-[#eef3f8] divide-y divide-[#f1f5f9] max-h-[340px] overflow-auto">
        {shown.map((l) => {
          const cfg = STATUS[l.status];
          const cv = l.contact_id ? convos.get(l.contact_id) : undefined;
          return (
            <li key={l.id} className="flex items-start gap-2.5 px-3 py-2 hover:bg-[#fafcfe]">
              <span className="text-base leading-none mt-0.5" title={cfg.label}>{cfg.emoji}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-[#1f3559] truncate">{l.contact_name || l.email || "—"}</span>
                  {l.ai_off && <span className="text-[9px] font-bold uppercase px-1 py-0.5 rounded bg-[#fdecec] text-[#b91c1c]">AI off</span>}
                </div>
                {cv?.last_message_body && (
                  <p className="text-xs text-[#697a91] truncate">
                    <span className={cv.last_message_direction === "inbound" ? "text-[#15803d]" : "text-[#8595a8]"}>
                      {cv.last_message_direction === "inbound" ? "↩ " : "→ "}
                    </span>
                    {cv.last_message_body}
                  </p>
                )}
              </div>
              <span className="text-[10px] text-[#8595a8] shrink-0 mt-0.5">{fmtDate(cv?.last_message_date ?? l.date_added)}</span>
            </li>
          );
        })}
      </ul>

      {/* AI suggestion slot (wired to real analysis next) */}
      <div className="rounded-lg border border-dashed border-[#c9b8f0] bg-[#faf7ff] p-3 flex items-start gap-2">
        <Sparkles size={15} className="text-[#7e22ce] mt-0.5 shrink-0" />
        <div className="text-xs text-[#5b3a9e]">
          <span className="font-semibold">AI suggestion</span> — based on the last 14 days. Coming next: an automatic read of what to act on (follow up the 🔥 offer-not-booked leads, re-engage 🔴 stalled, etc.).
        </div>
      </div>
    </div>
  );
}
