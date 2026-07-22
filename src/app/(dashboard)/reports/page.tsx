"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTableData } from "@/lib/hooks/useTableData";
import { createClient } from "@/lib/supabase/client";
import { GhlNotes } from "@/components/clients/GhlNotes";
import { formatDate, cn } from "@/lib/utils";
import { Search, Sparkles, Loader2 } from "lucide-react";
import { toast } from "sonner";

// ── helpers ──────────────────────────────────────────────────────────────────
const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = parseFloat(String(v).replace(/[$,%]/g, ""));
  return isNaN(n) ? null : n;
};
// performance_tracking dates are mostly MM/DD/YYYY (with some DD/MM)
function parseMs(s: string): number {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const a = +m[1], b = +m[2], y = +m[3];
    const month = a > 12 ? b : a, day = a > 12 ? a : b;
    const dt = new Date(y, month - 1, day);
    return isNaN(dt.getTime()) ? 0 : dt.getTime();
  }
  const dt = new Date(s);
  return isNaN(dt.getTime()) ? 0 : dt.getTime();
}
function versionStyle(v: string): { bg: string; text: string; border: string } {
  const u = v.toLowerCase();
  if (u.includes("not interested")) return { bg: "#fde8ee", text: "#e11d48", border: "#f5c2cf" };
  if (u.includes("v2.3") || u.includes("v2.2")) return { bg: "#f3e8ff", text: "#7e22ce", border: "#e3cffb" };
  if (u.includes("v3")) return { bg: "#1d4ed8", text: "#ffffff", border: "#1d4ed8" };
  if (u.includes("v2")) return { bg: "#dcf5e0", text: "#15803d", border: "#bce6c8" };
  return { bg: "#f1f5f9", text: "#64748b", border: "#d7e0ea" };
}

function onState(v: unknown): boolean | null {
  const u = String(v ?? "").trim().toUpperCase();
  if (!u || u === "-" || u === "—") return null;
  if (["YES", "Y", "TRUE", "1", "ORGANIZED", "ORGANISED", "DONE"].includes(u)) return true;
  if (["NOT", "NO", "N", "FALSE", "0"].includes(u)) return false;
  return null;
}

interface Report {
  date: string; ms: number; raw: Record<string, unknown>;
  leads: number | null; booking: number | null; sessions: number | null; declining: number | null;
}

// Canonical "Action" options — mirrors the "Dropdown" tab column C on the sheet
// (the Action data-validation source). Keep these EXACT, including the trailing
// space on "Give a Call ☎️ ", so saved values match the sheet's dropdown.
// AI suggestions reuse the same strings so the emoji matches exactly.
const ACTION_OPTIONS = [
  "GMB ⭐️",
  "Check In 🤩",
  "Strategy call 🧠",
  "Fantastic Path 🎉",
  "Text Blast 💬",
  "Roleplay 🗣️",
  "Give a Call ☎️ ",
  "Increase Budget 💰",
  "No Action ⛔️",
  "Send Video 📹",
  "Power PMU Arrtist 🙋🏻‍♀️",
  "Offer switch to V3 🔵",
  "Offer switch to V2.3 🟣",
];
const ACTION_INCREASE_BUDGET = "Increase Budget 💰";
const ACTION_GMB = "GMB ⭐️";
const ACTION_STRATEGY_CALL = "Strategy call 🧠";
const ACTION_OFFER_V3 = "Offer switch to V3 🔵";
const ACTION_OFFER_V23 = "Offer switch to V2.3 🟣";

// "Nice" axis scale → a round max with ~5 even ticks
function niceScale(max: number): { max: number; step: number } {
  if (max <= 0) return { max: 1, step: 1 };
  const rough = max / 5;
  const p = Math.pow(10, Math.floor(Math.log10(rough)));
  const f = rough / p;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  return { max: Math.ceil(max / step) * step, step };
}
// ── SVG area chart: Y-axis scale + gridlines, X-axis dates, line + area + dots ─
function AreaChart({ values, dates, color, yFmt }: {
  values: number[]; dates: string[]; color: string; yFmt: (v: number) => string;
}) {
  const W = 380, H = 200, mL = 38, mR = 14, mT = 12, mB = 26;
  const plotW = W - mL - mR, plotH = H - mT - mB;
  const vals = values.map((v) => (isNaN(v) ? 0 : v));
  if (!vals.length) return <div className="h-52" />;
  const { max, step } = niceScale(Math.max(...vals, 1));
  const n = vals.length;
  const X = (i: number) => (n <= 1 ? mL + plotW / 2 : mL + (i * plotW) / (n - 1));
  const Y = (v: number) => mT + plotH - (v / max) * plotH;
  const line = vals.map((v, i) => `${X(i)},${Y(v)}`);
  const path = "M" + line.join(" L");
  const area = `${path} L${X(n - 1)},${mT + plotH} L${X(0)},${mT + plotH} Z`;
  const ticks: number[] = [];
  for (let t = 0; t <= max + 1e-9; t += step) ticks.push(t);
  const want = Math.min(5, n);
  const xIdx = want <= 1 ? [0] : Array.from({ length: want }, (_, k) => Math.round((k * (n - 1)) / (want - 1)));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 230 }}>
      {ticks.map((t, k) => (
        <g key={k}>
          <line x1={mL} x2={W - mR} y1={Y(t)} y2={Y(t)} stroke="#eef3f8" strokeWidth={1} />
          <text x={mL - 5} y={Y(t) + 4} textAnchor="end" fontSize={12} fill="#8595a8">{yFmt(t)}</text>
        </g>
      ))}
      <path d={area} fill={color} opacity={0.14} />
      <path d={path} fill="none" stroke={color} strokeWidth={2.6} />
      {vals.map((v, i) => <circle key={i} cx={X(i)} cy={Y(v)} r={3.5} fill="#ffffff" stroke={color} strokeWidth={2} />)}
      {xIdx.map((i) => (
        <text key={i} x={X(i)} y={H - 8} textAnchor="middle" fontSize={10.5} fill="#697a91">{dates[i] ?? ""}</text>
      ))}
    </svg>
  );
}

// ── behaviour & context row definitions ──────────────────────────────────────
const BEHAVIOURS: { label: string; key: string }[] = [
  { label: "Happy?", key: "Happy?" },
  { label: "Deposits?", key: "Deposits?" },
  { label: "Dashboard Organised", key: "Dashboard Organized?" },
  { label: "Called 2x in a Row", key: "Call 2X In a Row?" },
  { label: "Called within 24h", key: "Call In 24/H?" },
  { label: "Called 5–7 PM", key: "5-7 PM?" },
  { label: "3x Follow-ups", key: "3X Follow Ups?" },
  { label: "Price Discussed", key: "What’s the price?" },
  { label: "Follows Script", key: "Follow Script?" },
];

export default function ReportsPage() {
  const { data, loading, refetch } = useTableData<Record<string, unknown>>({ table: "performance_tracking" });
  const { data: rawClients } = useTableData<Record<string, unknown>>({ table: "clients_master" });
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"az" | "leads" | "growth">("az");
  const [selected, setSelected] = useState<string | null>(null);
  // Mobile-only: whether the user has tapped into a report (list → detail flow).
  const [mobilePicked, setMobilePicked] = useState(false);
  // local optimistic overrides for the editable Action column, keyed by sheet row
  const [actionEdits, setActionEdits] = useState<Record<number, string>>({});

  // client name → Version (from clients_master). Report names don't always
  // equal "Owner Full Name" exactly, so resolve by owner name, then business
  // name, then name-token overlap.
  const versionMap = useMemo(() => {
    const m = new Map<string, string>();
    const entries: { tokens: string[]; version: string }[] = [];
    rawClients.forEach((c) => {
      const v = String(c["Version"] ?? "").trim();
      if (!v) return;
      const owner = String(c["Owner Full Name"] ?? "").trim().toLowerCase();
      const biz = String(c["Business Name"] ?? "").trim().toLowerCase();
      if (owner) m.set(owner, v);
      if (biz && !m.has(biz)) m.set(biz, v);
      if (owner) entries.push({ tokens: owner.split(/\s+/).filter((t) => t.length > 1), version: v });
    });
    return {
      get(name: string): string {
        const k = name.trim().toLowerCase();
        const exact = m.get(k);
        if (exact) return exact;
        const tokens = k.split(/\s+/).filter((t) => t.length > 1);
        if (!tokens.length) return "";
        const hit = entries.find((e) =>
          tokens.every((t) => e.tokens.includes(t)) || e.tokens.every((t) => tokens.includes(t)));
        return hit?.version ?? "";
      },
    };
  }, [rawClients]);

  // client name → Google My Business active? (clients_master "GMB" = "true"/"false")
  const gmbMap = useMemo(() => {
    const m = new Map<string, boolean>();
    rawClients.forEach((c) => {
      const owner = String(c["Owner Full Name"] ?? "").trim().toLowerCase();
      if (owner) m.set(owner, String(c["GMB"] ?? "").trim().toLowerCase() === "true");
    });
    return m;
  }, [rawClients]);

  // client name → Version ('(V3)', '(V2.3)', '(V1)', '', 'Not Interested')
  const versionMap = useMemo(() => {
    const m = new Map<string, string>();
    rawClients.forEach((c) => {
      const owner = String(c["Owner Full Name"] ?? "").trim().toLowerCase();
      if (owner) m.set(owner, String(c["Version"] ?? "").trim());
    });
    return m;
  }, [rawClients]);

  // client name → Business Name (from clients_master, matched on Owner Full Name)
  const businessMap = useMemo(() => {
    const m = new Map<string, string>();
    rawClients.forEach((c) => {
      const owner = String(c["Owner Full Name"] ?? "").trim().toLowerCase();
      const biz = String(c["Business Name"] ?? "").trim();
      if (owner && biz) m.set(owner, biz);
    });
    return m;
  }, [rawClients]);

  // client name → daily budget $ (from performance_overview, one row per owner)
  const [budgetMap, setBudgetMap] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    const supabase = createClient();
    supabase.from("performance_overview").select("owner_name, daily_budget").then(({ data }) => {
      const m = new Map<string, number>();
      (data ?? []).forEach((r) => {
        const k = String((r as { owner_name?: string }).owner_name ?? "").trim().toLowerCase();
        const b = Number((r as { daily_budget?: unknown }).daily_budget);
        if (k && !isNaN(b)) m.set(k, b);
      });
      setBudgetMap(m);
    });
  }, []);

  // client name → GHL contact ID (same picker rule as the Clients tab) for GHL notes
  const contactIdMap = useMemo(() => {
    const m = new Map<string, string>();
    rawClients.forEach((c) => {
      const owner = String(c["Owner Full Name"] ?? "").trim().toLowerCase();
      if (!owner) return;
      for (const cand of [c["Contact ID"], c["contact_id"], c["GHL Contact ID"], c["_id2"]]) {
        const s = String(cand ?? "").trim();
        if (s.length >= 15 && /[a-zA-Z]/.test(s) && /^[a-zA-Z0-9_-]+$/.test(s)) { m.set(owner, s); break; }
      }
    });
    return m;
  }, [rawClients]);

  // Write an edited Action (col T) back to Supabase + the "Add Data - Tracking" sheet.
  const saveAction = useCallback(async (rowNumber: number, raw: Record<string, unknown>, value: string) => {
    const { _supabase_id, _row_number, ...rest } = raw;
    void _supabase_id; void _row_number;
    const res = await fetch("/api/sync/performance_tracking", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rowNumber, rowData: { ...rest, Action: value }, columns: ["Action"] }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.success) throw new Error(json.error || "save failed");
    setActionEdits((m) => ({ ...m, [rowNumber]: value }));
    toast.success(json.sheetsUpdated ? "Action saved & synced to the sheet" : "Action saved");
    refetch();
  }, [refetch]);

  // group reports by client
  const clients = useMemo(() => {
    const map = new Map<string, Report[]>();
    data.forEach((r) => {
      const name = String(r["Name"] ?? "").trim();
      const date = String(r["Date"] ?? "").trim();
      if (!name || !date) return;
      const rep: Report = {
        date, ms: parseMs(date), raw: r,
        leads: num(r["Total Leads"]), booking: num(r["Booking %"]),
        sessions: num(r["Sessions Done?"]), declining: num(r["Declining %"]),
      };
      (map.get(name) ?? map.set(name, []).get(name)!).push(rep);
    });
    return Array.from(map.entries()).map(([name, reps]) => {
      reps.sort((a, b) => a.ms - b.ms);
      const first = reps[0], last = reps[reps.length - 1];
      // "amount we got" = highest recorded value (the latest report can reset to 0)
      const leadsTotal = Math.max(0, ...reps.map((r) => r.leads ?? 0));
      const sessionsTotal = Math.max(0, ...reps.map((r) => r.sessions ?? 0));
      const bvals = reps.map((r) => r.booking).filter((b): b is number => b != null);
      const bookingRate = bvals.length ? (bvals.reduce((s, b) => s + b, 0) / bvals.length) * 100 : 0;
      const growth = first.leads && last.leads != null ? ((last.leads - first.leads) / first.leads) * 100 : 0;
      return { name, reports: reps, leadsTotal, sessionsTotal, bookingRate, count: reps.length, growth, last };
    });
  }, [data]);

  const listed = useMemo(() => {
    let list = clients;
    if (search) { const q = search.toLowerCase(); list = list.filter((c) => c.name.toLowerCase().includes(q)); }
    const sorted = [...list];
    if (sort === "az") sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "leads") sorted.sort((a, b) => b.leadsTotal - a.leadsTotal);
    else sorted.sort((a, b) => b.growth - a.growth);
    return sorted;
  }, [clients, search, sort]);

  const current = useMemo(() => clients.find((c) => c.name === selected) ?? listed[0], [clients, listed, selected]);
  const reps = current?.reports ?? [];
  const gmbActive = current ? gmbMap.get(current.name.toLowerCase()) === true : false;
  const dailyBudget = current ? budgetMap.get(current.name.toLowerCase()) ?? null : null;
  const ghlContactId = current ? contactIdMap.get(current.name.toLowerCase()) ?? "" : "";

  // ── AI suggestions (rule-based) — each is one of the canonical Action options ──
  const suggestions = useMemo(() => {
    const out: { option: string; accent: string; body: string }[] = [];
    if (!current) return out;
    const rr = current.reports;
    // Rule 1: booking rate up across 3 consecutive reports → Increase Budget 💰
    if (rr.length >= 3) {
      const [a, b, c] = rr.slice(-3).map((r) => r.booking);
      if (a != null && b != null && c != null && b > a && c > b) {
        out.push({
          option: ACTION_INCREASE_BUDGET,
          accent: "#16a34a",
          body: `Booking rate climbed three reports in a row (${(a * 100).toFixed(1)}% → ${(b * 100).toFixed(1)}% → ${(c * 100).toFixed(1)}%). Scale the budget while conversion is rising.`,
        });
      }
    }
    // Rule 2: from the 2nd report onward, suggest GMB ⭐️ if it isn't active yet
    if (rr.length >= 2 && !gmbActive) {
      out.push({
        option: ACTION_GMB,
        accent: "#eab308",
        body: "Google My Business isn't active yet. Turning it on early (by the 2nd report) adds a strong local-trust and review source.",
      });
    }
    // Rule 3: early on (first 3 reports), touch base monthly — suggest a strategy
    // call if there hasn't been one in the last 30 days.
    if (rr.length <= 3) {
      let lastStrategyMs = 0;
      rr.forEach((r) => {
        const d = String(r.raw["Last Strategy?"] ?? "").trim();
        if (d) { const ms = parseMs(d); if (ms > lastStrategyMs) lastStrategyMs = ms; }
      });
      const daysSince = lastStrategyMs ? Math.round((Date.now() - lastStrategyMs) / 86400000) : null;
      if (daysSince == null || daysSince > 30) {
        out.push({
          option: ACTION_STRATEGY_CALL,
          accent: "#7c3aed",
          body: daysSince == null
            ? "No strategy call logged yet. In the first 3 months, touch base at least once a month — book a strategy call."
            : `Last strategy call was ${daysSince} days ago. In the first 3 months, touch base at least monthly — book a strategy call.`,
        });
      }
    }
    // ── Version-upgrade rules ──
    const version = versionMap.get(current.name.trim().toLowerCase()) ?? "";
    const isV3 = /v3/i.test(version);
    const noAutomation = /v1|not\s*interested/i.test(version) || version === "";
    const latest = rr[rr.length - 1];
    const latestBooking = latest?.booking ?? null;
    // "Launch anchor" = the earliest signal we have for when this client
    // started: their first tracking report, or an earlier logged strategy call.
    let anchorMs = rr[0]?.ms ?? 0;
    rr.forEach((r) => {
      const d = String(r.raw["Last Strategy?"] ?? "").trim();
      if (d) { const ms = parseMs(d); if (ms && ms < anchorMs) anchorMs = ms; }
    });
    const monthsSinceLaunch = anchorMs ? (Date.now() - anchorMs) / (30 * 86400000) : 0;

    // Rule 4: not on V3, 2+ months in, booking rate stuck under 6% → offer V3.
    if (!isV3 && latestBooking != null && latestBooking < 0.06 && monthsSinceLaunch >= 2) {
      out.push({
        option: ACTION_OFFER_V3,
        accent: "#2563eb",
        body: `Booking rate is ${(latestBooking * 100).toFixed(1)}% after ${Math.floor(monthsSinceLaunch)}+ months since launch — below the 6% benchmark. Offer the V3 upgrade so the AI takes over follow-up and booking.`,
      });
    }
    // Rule 5: not on V3, booking rate sliding down 3 reports in a row and
    // getting close to the 6% line → offer V3 before it drops under.
    else if (!isV3 && rr.length >= 3) {
      const [a, b, c] = rr.slice(-3).map((r) => r.booking);
      if (a != null && b != null && c != null && b < a && c < b && c < 0.09) {
        out.push({
          option: ACTION_OFFER_V3,
          accent: "#2563eb",
          body: `Booking rate is sliding (${(a * 100).toFixed(1)}% → ${(b * 100).toFixed(1)}% → ${(c * 100).toFixed(1)}%) and approaching the 6% line. Offer the V3 upgrade before it drops further.`,
        });
      }
    }
    // Rule 6: doing well WITHOUT automation (V1 / no version / "Not
    // Interested") → offer V2.3 to add auto-bookings on top of the manual work.
    if (noAutomation && latest && ((latest.sessions ?? 0) > 0 || (latestBooking ?? 0) >= 0.06)) {
      out.push({
        option: ACTION_OFFER_V23,
        accent: "#9333ea",
        body: `Doing well on ${version || "manual work"} (${latestBooking != null ? (latestBooking * 100).toFixed(1) + "% booking" : "steady sessions"}) with no automation. Offer V2.3 to add automated bookings on top of their great manual work.`,
      });
    }
    return out;
  }, [current, gmbActive, versionMap]);

  return (
    <div className="flex h-full">
      {/* ── Sidebar — full-width list on mobile; hidden there once a report is open ── */}
      <div className={`w-full md:w-[20%] md:min-w-[210px] md:max-w-[300px] border-r border-[#e4ebf2] flex-col h-full bg-white ${mobilePicked ? "hidden md:flex" : "flex"}`}>
        <div className="p-2.5 border-b border-[#e4ebf2] space-y-2">
          <div className="relative">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#697a91]" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search clients…"
              className="w-full pl-8 pr-3 py-2 bg-[#eef2f7] border border-[#e4ebf2] rounded-lg text-sm text-[#1f3559] placeholder:text-[#8595a8] focus:outline-none focus:border-[#15B7AE]" />
          </div>
          <div className="grid grid-cols-3 gap-1">
            {([["az", "A–Z"], ["leads", "Leads"], ["growth", "Growth"]] as const).map(([v, l]) => (
              <button key={v} onClick={() => setSort(v)}
                className={cn("py-1.5 rounded-lg text-xs font-medium border transition-colors",
                  sort === v ? "bg-[#15B7AE] text-white border-[#15B7AE]" : "bg-white text-[#697a91] border-[#e4ebf2] hover:bg-[#f1f5f9]")}>
                {l}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {listed.map((c) => {
            const active = current?.name === c.name;
            return (
              <button key={c.name} onClick={() => { setSelected(c.name); setMobilePicked(true); }}
                className={cn("w-full text-left px-3 py-2 border-b border-[#eef3f8] flex items-center justify-between gap-2 hover:bg-[#f1f5f9] transition-colors",
                  active && "bg-[#e6f7f5] border-l-[3px] border-l-[#15B7AE]")}>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[#1f3559] truncate">{c.name}</p>
                  <p className="text-xs text-[#8595a8] truncate">{c.count} reports · {c.leadsTotal.toLocaleString()} leads · {c.sessionsTotal} sessions</p>
                </div>
                <span className="text-xs font-semibold whitespace-nowrap text-[#0e8f88]" title="Avg booking rate">
                  {c.bookingRate.toFixed(1)}%
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Main — full-screen report on mobile with a back button ── */}
      <div className={`flex-1 h-full overflow-auto ${!mobilePicked ? "hidden md:block" : ""}`}>
        <div className="md:hidden sticky top-0 z-20 flex items-center px-3 py-2 border-b border-[#e4ebf2] bg-white">
          <button onClick={() => setMobilePicked(false)} className="flex items-center gap-1 text-sm font-semibold text-[#0e8f88]">
            ‹ All clients
          </button>
        </div>
        {loading ? (
          <div className="p-10 text-center text-[#697a91]">Loading reports…</div>
        ) : !current ? (
          <div className="p-10 text-center text-[#8595a8]">No tracking data found.</div>
        ) : (
          <div className="p-4 sm:p-6 space-y-5 md:min-w-[900px]">
            {/* Header */}
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-xl font-bold text-[#1f3559]">{current.name}</h1>
              {(() => {
                const biz = businessMap.get(current.name.toLowerCase());
                return biz ? <span className="text-sm font-medium text-[#697a91]">· {biz}</span> : null;
              })()}
              {(() => {
                const r = current.last.raw;
                const badge = (label: string, on: boolean | null) => (
                  <span className={cn("px-2 py-0.5 rounded-full text-xs font-semibold border",
                    on === true ? "bg-[#e6f7f5] text-[#0e8f88] border-[#a7e3df]" : on === false ? "bg-[#fde8ee] text-[#e11d48] border-[#f5c2cf]" : "bg-[#f1f5f9] text-[#64748b] border-[#d7e0ea]")}>
                    {label}
                  </span>
                );
                return (
                  <>
                    {badge(`Happy: ${String(r["Happy?"] ?? "—")}`, onState(r["Happy?"]))}
                    {badge(`Deposits: ${String(r["Deposits?"] ?? "—")}`, onState(r["Deposits?"]))}
                    <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-[#eef2ff] text-[#3a5a8c] border border-[#c7d2fe]">Channel: {String(r["Call or Chat?"] ?? "—")}</span>
                    {dailyBudget != null && (
                      <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-[#f0fdf4] text-[#15803d] border border-[#bbf7d0]">
                        Budget: ${Math.round(dailyBudget).toLocaleString()}/d
                      </span>
                    )}
                    {badge(`GMB: ${gmbActive ? "Yes" : "No"}`, gmbActive)}
                    {(() => {
                      const ver = versionMap.get(current.name);
                      if (!ver) {
                        return <span className="px-2 py-0.5 rounded-full text-xs font-semibold border bg-[#f1f5f9] text-[#64748b] border-[#d7e0ea]">Version: —</span>;
                      }
                      const vs = versionStyle(ver);
                      return <span className="px-2 py-0.5 rounded-full text-xs font-semibold border" style={{ background: vs.bg, color: vs.text, borderColor: vs.border }}>Version: {ver}</span>;
                    })()}
                    <span className="text-xs text-[#697a91]">{current.count} reports · {formatDate(reps[0].date, true)} – {formatDate(current.last.date, true)}</span>
                    {String(r["Last Strategy?"] ?? "").trim() && (
                      <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-[#fff7ec] text-[#d97706] border border-[#fcd9a8]">
                        Last Strategy Call: {formatDate(String(r["Last Strategy?"]), true)}
                      </span>
                    )}
                  </>
                );
              })()}
            </div>

            {/* AI suggestions */}
            {suggestions.length > 0 && (
              <div className="rounded-2xl border border-[#bfe9e5] bg-gradient-to-br from-[#f0fbfa] to-[#eef4ff] p-4 space-y-2.5">
                <div className="flex items-center gap-2">
                  <Sparkles size={15} className="text-[#0e8f88]" />
                  <h2 className="text-sm font-bold text-[#0e8f88]">AI Suggestions</h2>
                  <span className="text-[10px] text-[#697a91]">based on this client&apos;s report trend</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                  {suggestions.map((s, i) => (
                    <div key={i} className="rounded-xl bg-white/80 border border-[#e4ebf2] border-l-4 p-3" style={{ borderLeftColor: s.accent }}>
                      <p className="text-sm font-semibold text-[#1f3559]">{s.option}</p>
                      <p className="text-xs text-[#56678a] leading-snug mt-0.5">{s.body}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <ChartCard title="Total Leads Over Time" color="#34568a" values={reps.map((r) => r.leads ?? 0)} dates={reps.map((r) => r.date)} yFmt={(v) => String(Math.round(v))} />
              <ChartCard title="Booking Rate %" color="#15B7AE" values={reps.map((r) => (r.booking ?? 0) * 100)} dates={reps.map((r) => r.date)} yFmt={(v) => `${Math.round(v)}%`} />
              <ChartCard title="Sessions Booked" color="#7e8fc4" values={reps.map((r) => r.sessions ?? 0)} dates={reps.map((r) => r.date)} yFmt={(v) => String(Math.round(v))} />
            </div>

            {/* Date-by-date comparison */}
            <div className="rounded-2xl border border-[#e4ebf2] bg-white overflow-hidden">
              <div className="px-5 py-3 border-b border-[#e4ebf2]">
                <h2 className="text-sm font-semibold text-[#34568a]">Date-by-Date Comparison — read left→right to compare each date to the one before</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="text-sm border-collapse w-full">
                  <thead>
                    <tr style={{ background: "linear-gradient(180deg,#34568a,#26416b)" }} className="text-white">
                      <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wider sticky left-0 z-10" style={{ background: "#2d4c79" }}>Metric</th>
                      {reps.map((r, i) => (
                        <th key={i} className="px-3 py-2 text-center text-[10px] font-bold uppercase whitespace-nowrap">
                          #{i + 1}<br /><span className="font-medium opacity-80">{r.date}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <SectionRow label="Context" span={reps.length} />
                    <ContextRow label="Call or Chat" reps={reps} get={(r) => String(r.raw["Call or Chat?"] ?? "—")} />
                    <ContextRow label="Last Strategy" reps={reps} get={(r) => { const d = String(r.raw["Last Strategy?"] ?? ""); return d ? formatDate(d, true) : "—"; }} />
                    <ActionRow reps={reps} edits={actionEdits} onSave={saveAction} />

                    <SectionRow label="Metric" span={reps.length} />
                    <NumRow label="Total Leads" reps={reps} get={(r) => r.leads} fmt={(v) => String(v)} higherBetter />
                    <NumRow label="Booking %" reps={reps} get={(r) => (r.booking == null ? null : r.booking * 100)} fmt={(v) => `${v.toFixed(2)}%`} higherBetter />
                    <NumRow label="Sessions Booked" reps={reps} get={(r) => r.sessions} fmt={(v) => String(v)} higherBetter />
                    <NumRow label="Declining %" reps={reps} get={(r) => (r.declining == null ? null : r.declining * 100)} fmt={(v) => `${v.toFixed(2)}%`} higherBetter={false} />

                    <SectionRow label="Behaviours & Process" span={reps.length} />
                    {BEHAVIOURS.map((b) => <BehaviourRow key={b.key} label={b.label} bkey={b.key} reps={reps} />)}
                  </tbody>
                </table>
              </div>
            </div>
            <p className="text-xs text-[#8595a8]">Green = on track, red = off track. Numeric cells show the change vs the previous date (▲/▼).</p>

            {/* Notes from GoHighLevel — same as the Clients tab */}
            {ghlContactId && <GhlNotes contactId={ghlContactId} />}
          </div>
        )}
      </div>
    </div>
  );
}

function ChartCard({ title, color, values, dates, yFmt }: { title: string; color: string; values: number[]; dates: string[]; yFmt: (v: number) => string }) {
  return (
    <div className="rounded-2xl border border-[#e4ebf2] bg-white p-4">
      <h3 className="text-xs font-bold uppercase tracking-wide text-[#34568a] mb-2">{title}</h3>
      <AreaChart values={values} dates={dates} color={color} yFmt={yFmt} />
    </div>
  );
}

function SectionRow({ label, span }: { label: string; span: number }) {
  return (
    <tr className="bg-[#eef2f7]">
      <td colSpan={span + 1} className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[#34568a] sticky left-0 bg-[#eef2f7]">{label}</td>
    </tr>
  );
}

function NumRow({ label, reps, get, fmt, higherBetter }: {
  label: string; reps: Report[]; get: (r: Report) => number | null; fmt: (v: number) => string; higherBetter: boolean;
}) {
  return (
    <tr className="border-b border-[#eef3f8]">
      <td className="px-3 py-2 font-medium text-[#1f3559] whitespace-nowrap sticky left-0 bg-white">{label}</td>
      {reps.map((r, i) => {
        const v = get(r);
        const prev = i > 0 ? get(reps[i - 1]) : null;
        const d = v != null && prev != null ? v - prev : null;
        const good = d == null ? null : higherBetter ? d >= 0 : d <= 0;
        return (
          <td key={i} className="px-3 py-2 text-center whitespace-nowrap text-[#1e2a3a]">
            {v == null ? <span className="text-[#a6b3c4]">–</span> : fmt(v)}
            {d != null && Math.abs(d) > 0.001 && (
              <span className={cn("ml-1 text-[10px] font-semibold", good ? "text-[#0e8f88]" : "text-[#e11d48]")}>
                {d > 0 ? "▲" : "▼"}{Math.abs(Math.round(d * 100) / 100)}
              </span>
            )}
          </td>
        );
      })}
    </tr>
  );
}

function BehaviourRow({ label, bkey, reps }: { label: string; bkey: string; reps: Report[] }) {
  return (
    <tr className="border-b border-[#eef3f8]">
      <td className="px-3 py-2 font-medium text-[#34568a] whitespace-nowrap sticky left-0 bg-white">{label}</td>
      {reps.map((r, i) => {
        const raw = r.raw[bkey];
        const on = onState(raw);
        const prevOn = i > 0 ? onState(reps[i - 1].raw[bkey]) : on;
        const flipped = i > 0 && prevOn !== on && (on != null || prevOn != null);
        const txt = String(raw ?? "").trim() || "–";
        return (
          <td key={i} className={cn("px-3 py-2 text-center text-xs font-semibold",
            on === true ? "bg-[#e6f7f5] text-[#0e8f88]" : on === false ? "bg-[#fde8ee] text-[#e11d48]" : "text-[#a6b3c4]",
            flipped && (on === true ? "border-l-4 border-l-[#0e8f88]" : "border-l-4 border-l-[#e11d48]"))}>
            {txt}
          </td>
        );
      })}
    </tr>
  );
}

function ContextRow({ label, reps, get }: { label: string; reps: Report[]; get: (r: Report) => string }) {
  return (
    <tr className="border-b border-[#eef3f8]">
      <td className="px-3 py-2 font-medium text-[#34568a] whitespace-nowrap sticky left-0 bg-white">{label}</td>
      {reps.map((r, i) => <td key={i} className="px-3 py-2 text-center whitespace-nowrap text-[#34568a]">{get(r)}</td>)}
    </tr>
  );
}

// Editable "Action" row (col T of "Add Data - Tracking") — writes back to the sheet.
function ActionRow({ reps, edits, onSave }: {
  reps: Report[];
  edits: Record<number, string>;
  onSave: (rowNumber: number, raw: Record<string, unknown>, value: string) => Promise<void>;
}) {
  return (
    <tr className="border-b border-[#eef3f8]">
      <td className="px-3 py-2 font-medium text-[#34568a] whitespace-nowrap sticky left-0 bg-white">Action</td>
      {reps.map((r, i) => <ActionCell key={i} report={r} edits={edits} onSave={onSave} />)}
    </tr>
  );
}

function ActionCell({ report, edits, onSave }: {
  report: Report;
  edits: Record<number, string>;
  onSave: (rowNumber: number, raw: Record<string, unknown>, value: string) => Promise<void>;
}) {
  const rowNumber = Number(report.raw["_row_number"] ?? report.raw["row_number"]) || 0;
  const value = edits[rowNumber] ?? String(report.raw["Action"] ?? "");
  const [saving, setSaving] = useState(false);

  const change = async (next: string) => {
    if (!rowNumber) { toast.error("No sheet row found for this report"); return; }
    if (next === value) return;
    setSaving(true);
    try {
      await onSave(rowNumber, report.raw, next);
    } catch {
      toast.error("Couldn't save the action");
    } finally {
      setSaving(false);
    }
  };

  // Keep any legacy free-text value selectable so an edit never loses it.
  const options = value && !ACTION_OPTIONS.includes(value) ? [value, ...ACTION_OPTIONS] : ACTION_OPTIONS;

  return (
    <td className="px-3 py-2 text-center min-w-[150px]">
      <div className="inline-flex items-center gap-1">
        <select value={value} onChange={(e) => change(e.target.value)} disabled={saving} title="Set the action (synced to the sheet)"
          className="max-w-[170px] text-xs rounded border border-[#d7e0ea] bg-white px-2 py-1 text-[#34568a] cursor-pointer focus:outline-none focus:border-[#15B7AE] disabled:opacity-60">
          <option value="">—</option>
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        {saving && <Loader2 size={11} className="animate-spin text-[#94a3b8]" />}
      </div>
    </td>
  );
}
