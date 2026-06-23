"use client";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

interface DayRow {
  owner_key: string;
  day: string;
  leads: number;
  conversations: number;
  answered: number;
  no_answer: number;
  opportunities: number;
}

const SERIES = [
  { key: "leads", label: "Leads", color: "#15B7AE" },
  { key: "conversations", label: "Communications", color: "#185FA5" },
  { key: "no_answer", label: "No answer", color: "#e11d48" },
  { key: "opportunities", label: "Opportunities", color: "#7e22ce" },
] as const;

function LineChart({ rows, active }: { rows: DayRow[]; active: Record<string, boolean> }) {
  const W = 820, H = 280, padL = 38, padR = 14, padT = 14, padB = 28;
  const n = rows.length;
  const shown = SERIES.filter((s) => active[s.key]);
  const maxV = Math.max(1, ...rows.flatMap((r) => shown.map((s) => r[s.key as keyof DayRow] as number)));
  const x = (i: number) => padL + (n <= 1 ? 0 : (i / (n - 1)) * (W - padL - padR));
  const y = (v: number) => padT + (1 - v / maxV) * (H - padT - padB);
  const path = (k: string) => rows.map((r, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(r[k as keyof DayRow] as number).toFixed(1)}`).join(" ");
  const ticks = 4;
  const labelEvery = Math.max(1, Math.ceil(n / 8));

  if (!n) return <div className="text-sm text-[#8595a8] py-16 text-center">No data for this client yet.</div>;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 300 }}>
      {Array.from({ length: ticks + 1 }).map((_, i) => {
        const v = Math.round((maxV * (ticks - i)) / ticks);
        const yy = padT + (i / ticks) * (H - padT - padB);
        return (
          <g key={i}>
            <line x1={padL} y1={yy} x2={W - padR} y2={yy} stroke="#eef3f8" strokeWidth={1} />
            <text x={padL - 6} y={yy + 3} textAnchor="end" fontSize={9} fill="#8595a8">{v}</text>
          </g>
        );
      })}
      {rows.map((r, i) => i % labelEvery === 0 && (
        <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize={8.5} fill="#8595a8">
          {r.day.slice(5)}
        </text>
      ))}
      {SERIES.filter((s) => active[s.key]).map((s) => (
        <path key={s.key} d={path(s.key)} fill="none" stroke={s.color} strokeWidth={2.2} />
      ))}
    </svg>
  );
}

export default function InsightsPage() {
  const [supabase] = useState(() => createClient());
  const [owners, setOwners] = useState<string[]>([]);
  const [owner, setOwner] = useState("");
  const [rows, setRows] = useState<DayRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [rangeDays, setRangeDays] = useState(90);
  const [active, setActive] = useState<Record<string, boolean>>({ leads: true, conversations: true, no_answer: true, opportunities: true });

  useEffect(() => {
    supabase.from("ghl_daily_metrics").select("owner_key").then(({ data }) => {
      const uniq = Array.from(new Set((data ?? []).map((r) => r.owner_key as string))).filter(Boolean).sort();
      setOwners(uniq);
      setOwner((o) => o || uniq[0] || "");
    });
  }, [supabase]);

  useEffect(() => {
    if (!owner) { setLoading(false); return; }
    setLoading(true);
    supabase.from("ghl_daily_metrics").select("*").eq("owner_key", owner).order("day", { ascending: true })
      .then(({ data }) => { setRows((data as DayRow[]) ?? []); setLoading(false); });
  }, [owner, supabase]);

  const filtered = useMemo(() => {
    if (rangeDays === 0) return rows;
    const cutoff = new Date(Date.now() - rangeDays * 86400000).toISOString().slice(0, 10);
    return rows.filter((r) => r.day >= cutoff);
  }, [rows, rangeDays]);

  const totals = useMemo(() => {
    const t = { leads: 0, conversations: 0, answered: 0, no_answer: 0, opportunities: 0 };
    filtered.forEach((r) => { t.leads += r.leads; t.conversations += r.conversations; t.answered += r.answered; t.no_answer += r.no_answer; t.opportunities += r.opportunities; });
    return t;
  }, [filtered]);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-semibold text-[#1f3559]">Conversation Insights</h1>
          <p className="text-xs text-[#697a91]">Daily leads, communications & funnel from GoHighLevel · V3 clients</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={owner} onChange={(e) => setOwner(e.target.value)}
            className="px-3 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm text-[#34568a] focus:outline-none focus:border-[#15B7AE]">
            {owners.length === 0 && <option value="">No data yet</option>}
            {owners.map((o) => <option key={o} value={o}>{o.replace(/\b\w/g, (c) => c.toUpperCase())}</option>)}
          </select>
          <select value={rangeDays} onChange={(e) => setRangeDays(Number(e.target.value))}
            className="px-3 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm text-[#34568a] focus:outline-none focus:border-[#15B7AE]">
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last year</option>
            <option value={0}>All time</option>
          </select>
        </div>
      </div>

      {/* Totals */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { label: "Leads", val: totals.leads, color: "#15B7AE" },
          { label: "Communications", val: totals.conversations, color: "#185FA5" },
          { label: "Answered", val: totals.answered, color: "#15803d" },
          { label: "No answer", val: totals.no_answer, color: "#e11d48" },
          { label: "Opportunities", val: totals.opportunities, color: "#7e22ce" },
        ].map((c) => (
          <div key={c.label} className="rounded-xl border border-[#e4ebf2] bg-white px-4 py-3">
            <p className="text-[11px] font-medium text-[#697a91]">{c.label}</p>
            <p className="text-xl font-bold" style={{ color: c.color }}>{c.val.toLocaleString()}</p>
          </div>
        ))}
      </div>

      {/* Chart */}
      <div className="rounded-[14px] border border-[#e4ebf2] bg-white p-4" style={{ boxShadow: "var(--shadow-sm)" }}>
        <div className="flex items-center gap-3 flex-wrap mb-2">
          {SERIES.map((s) => (
            <button key={s.key} onClick={() => setActive((a) => ({ ...a, [s.key]: !a[s.key] }))}
              className="flex items-center gap-1.5 text-xs font-medium"
              style={{ opacity: active[s.key] ? 1 : 0.35 }}>
              <span className="w-3 h-1.5 rounded-full" style={{ background: s.color }} />
              {s.label}
            </button>
          ))}
        </div>
        {loading ? (
          <div className="text-sm text-[#697a91] py-16 text-center">Loading…</div>
        ) : (
          <LineChart rows={filtered} active={active} />
        )}
      </div>
    </div>
  );
}
