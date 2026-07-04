"use client";
import { Fragment, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatCurrency, userColor, cn } from "@/lib/utils";
import { Search, ChevronRight, Copy, X } from "lucide-react";
import { ActivityLog } from "@/components/activity/ActivityLog";
import { LeadBreakdown } from "@/components/clients/LeadBreakdown";

interface Row {
  sheet_row: number;
  client_status: string | null;
  owner_name: string | null;
  ad_account_name: string | null;
  version: string | null;
  assigned: string | null;
  media_buyer: string | null;
  original_price: string | null;
  discounted_price: string | null;
  offer: string | null;
  current_offer: string | null;
  deposit_amount: string | null;
  leads_all: number | null;
  deposits_all: number | null;
  l14: number | null;
  l30: number | null;
  l3: number | null;
  l7: number | null;
  // GHL booking funnel stats (null when the client has no GHL data)
  b14: number | null;
  b30: number | null;
  bnd14: number | null;
  bnd30: number | null;
  gl14: number | null;
  gl30: number | null;
  daily_budget: number | string | null;
  d3: number; d7: number; d14: number; d30: number;
  spent7: number | string | null; spent14: number | string | null; spent30: number | string | null;
  cpd7: number | string | null; cpd14: number | string | null; cpd30: number | string | null;
}

interface Dup {
  owner_name: string | null;
  full_name: string | null;
  email: string | null;
  deposit_count: number;
  dates: string | null;
}

const num = (v: unknown) => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[$,]/g, ""));
  return isNaN(n) ? null : n;
};
const money0 = (v: unknown) => { const n = num(v); return n == null ? "—" : "$" + +n.toFixed(2); };

type Vivid = { bg: string; fg: string };
const V = {
  green:  { bg: "#33d15b", fg: "#0a3d18" },
  yellow: { bg: "#ffe000", fg: "#5c4600" },
  orange: { bg: "#ff9f1a", fg: "#5c3200" },
  red:    { bg: "#ff4d40", fg: "#5c0000" },
  gray:   { bg: "#e3e8ec", fg: "#8a96a3" },
};
// Deposits: higher is better
const depVivid = (v: number, g: number, a: number): Vivid => (v >= g ? V.green : v >= a ? V.yellow : V.red);
// Paused clients: gray when 0, orange when deposits still come in (matches Performance).
const depCellTone = (v: number, g: number, a: number, paused: boolean): Vivid =>
  paused ? (v !== 0 ? V.orange : V.gray) : depVivid(v, g, a);
// Cost per deposit: lower is better; $0 / none = gray
const cpdVivid = (v: number | null): Vivid =>
  v == null || v <= 0 ? V.gray : v < 75 ? V.green : v < 150 ? V.yellow : v < 250 ? V.orange : V.red;
// Book rate (leads → picked a date/time), % of GHL leads: higher is better
const bookTone = (v: number | null): Vivid =>
  v == null ? V.gray : v >= 30 ? V.green : v >= 18 ? V.yellow : v >= 10 ? V.orange : V.red;
// Booked-but-no-deposit share (of booked): lower is better
const noDepTone = (booked: number | null, noDep: number | null): Vivid => {
  if (booked == null || noDep == null || booked <= 0) return V.gray;
  const r = noDep / booked;
  return r <= 0.5 ? V.green : r <= 0.75 ? V.yellow : r <= 0.9 ? V.orange : V.red;
};
// Lead→deposit conversion %: higher is better; no leads = gray (mirrors ratioTone bands)
const convTone = (v: number | null): Vivid =>
  v == null ? V.gray : v >= 10 ? V.green : v >= 5.5 ? V.yellow : v >= 3.3 ? V.orange : V.red;

// ── Funnel Health ────────────────────────────────────────────────────────────
// Score built from the four funnel columns (Leads/Dep 30, Leads/Dep 14,
// Conv% 30, Conv% 14) using the SAME color bands as the cells:
// green=3, yellow=2, orange=1, red=0 points per metric, averaged (0–3).
// Leads but zero deposits counts as red (0) — that's the worst funnel state.
// No lead data at all → null (sorted to the bottom in both directions).
function funnelHealth(r: Row): number | null {
  const ratio30 = r.d30 > 0 ? Math.round((r.l30 ?? 0) / r.d30) : null;
  const ratio14 = r.d14 > 0 ? Math.round((r.l14 ?? 0) / r.d14) : null;
  const conv30 = r.l30 && r.l30 > 0 ? (r.d30 / r.l30) * 100 : null;
  const conv14 = r.l14 && r.l14 > 0 ? (r.d14 / r.l14) * 100 : null;

  const ratioPts = (v: number | null, hasLeads: boolean): number | null =>
    v != null ? (v <= 10 ? 3 : v <= 18 ? 2 : v <= 30 ? 1 : 0) : hasLeads ? 0 : null;
  const convPts = (v: number | null): number | null =>
    v == null ? null : v >= 10 ? 3 : v >= 5.5 ? 2 : v >= 3.3 ? 1 : 0;

  const pts = [
    ratioPts(ratio30, (r.l30 ?? 0) > 0),
    ratioPts(ratio14, (r.l14 ?? 0) > 0),
    convPts(conv30),
    convPts(conv14),
  ].filter((p): p is number => p != null);
  if (pts.length === 0) return null;
  return pts.reduce((s, p) => s + p, 0) / pts.length;
}
const healthTone = (s: number | null): Vivid =>
  s == null ? V.gray : s >= 2.5 ? V.green : s >= 1.5 ? V.yellow : s >= 0.75 ? V.orange : V.red;

function UserCell({ name }: { name: string | null }) {
  if (!name) return <span className="text-[#a6b3c4]">—</span>;
  const c = userColor(name);
  return (
    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap border"
      style={{ background: c?.bg, color: c?.text, borderColor: c?.border }}>{name}</span>
  );
}

// Compact cell for free-text values: short values render inline; long ones
// truncate to a narrow width and expand/collapse on click so one client's long
// note doesn't stretch the whole column.
function ExpandText({ value }: { value: string | null }) {
  const [open, setOpen] = useState(false);
  if (!value) return <span className="text-[#a6b3c4]">—</span>;
  if (value.length <= 14) return <span className="whitespace-nowrap">{value}</span>;
  return (
    <span
      onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
      title={open ? "Click to collapse" : value}
      className={cn("cursor-pointer inline-block align-bottom", open ? "whitespace-normal break-words max-w-[220px]" : "max-w-[72px] truncate")}
    >
      {value}
    </span>
  );
}

const HEADERS = ["Owner Name", "Ad Account Name", "Daily Budget", "Assigned", "Media Buyer", "Original $", "Discounted $", "Current Offer", "Deposit $", "D 30", "D 14", "D 7", "D 3", "L 30", "L 14", "L 7", "L 3", "Book% 30", "Book% 14", "No-Dep 30", "No-Dep 14", "Conv% 30", "Conv% 14", "CPD 30", "CPD 14", "CPD 7", "Spent 30", "Spent 14", "Spent 7"];

export default function CostPerDepositPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [assignee, setAssignee] = useState("All");
  const [versionFilter, setVersionFilter] = useState("All");
  const [sortMode, setSortMode] = useState<"default" | "fh-best" | "fh-worst">("default");
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [dups, setDups] = useState<Dup[]>([]);
  const [dupOpen, setDupOpen] = useState(false);
  const [ghlKeys, setGhlKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    const supabase = createClient();
    (async () => {
      // Booking stats live in their own small view (booking_stats) and are
      // merged client-side — folding them into deposit_overview made that
      // query exceed the browser's statement timeout.
      type Bk = { owner_key: string; b14: number | null; b30: number | null; bnd14: number | null; bnd30: number | null; gl14: number | null; gl30: number | null };
      const [ovRes, bkRes] = await Promise.all([
        supabase.from("deposit_overview").select("*"),
        supabase.from("booking_stats").select("*"),
      ]);
      if (ovRes.error) { setError(ovRes.error.message); setLoading(false); return; }
      const bkMap = new Map(((bkRes.data as Bk[]) ?? []).map((b) => [String(b.owner_key), b]));
      const merged = (((ovRes.data as Row[]) ?? [])).map((r) => {
        const b = bkMap.get(String(r.owner_name ?? "").toLowerCase().trim());
        return { ...r, b14: b?.b14 ?? null, b30: b?.b30 ?? null, bnd14: b?.bnd14 ?? null, bnd30: b?.bnd30 ?? null, gl14: b?.gl14 ?? null, gl30: b?.gl30 ?? null };
      });
      setRows(merged);
      // owners with GHL conversation data = owners present in booking_stats
      setGhlKeys(new Set(bkMap.keys()));
      setLoading(false);
      const { data: dup } = await supabase.from("deposit_duplicates").select("*");
      setDups(((dup as Dup[]) ?? []).sort((a, b) => b.deposit_count - a.deposit_count));
    })();
  }, []);

  const assignees = useMemo(() => ["All", ...Array.from(new Set(rows.map((r) => r.assigned).filter(Boolean) as string[])).sort()], [rows]);

  const filtered = useMemo(() => {
    const list = rows.filter((r) => {
      if (assignee !== "All" && r.assigned !== assignee) return false;
      if (versionFilter !== "All") {
        const ver = (r.version ?? "").toLowerCase();
        if (versionFilter === "V3" && !ver.includes("v3")) return false;
        if (versionFilter === "V2.3" && !ver.includes("v2.3")) return false;
      }
      if (search && !`${r.owner_name ?? ""} ${r.ad_account_name ?? ""}`.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
    // Paused clients always sink to the bottom, in every sort mode.
    const rank = (s: string | null) => (String(s ?? "").toLowerCase() === "paused" ? 1 : 0);
    if (sortMode === "default") {
      return list.sort((a, b) => rank(a.client_status) - rank(b.client_status) || b.d30 - a.d30);
    }
    // Funnel Health sort: score from Leads/Dep 30+14 and Conv% 30+14.
    // Clients with no lead data (null score) go last in both directions.
    const dir = sortMode === "fh-best" ? -1 : 1;
    return list.sort((a, b) => {
      const pr = rank(a.client_status) - rank(b.client_status);
      if (pr !== 0) return pr;
      const ha = funnelHealth(a), hb = funnelHealth(b);
      if (ha == null && hb == null) return b.d30 - a.d30;
      if (ha == null) return 1;
      if (hb == null) return -1;
      if (ha !== hb) return dir * (ha - hb);
      return b.d30 - a.d30; // tie-break: more deposits first
    });
  }, [rows, search, assignee, versionFilter, sortMode]);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-semibold text-[#1f3559]">Cost Per Deposit</h1>
          <p className="text-xs text-[#697a91]">V3 &amp; V2.3 clients · deposits &amp; cost-per-deposit</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#697a91]" />
            <input type="text" placeholder="Search owner or ad account…" value={search} onChange={(e) => setSearch(e.target.value)}
              className="pl-8 pr-3 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm text-[#1f3559] placeholder:text-[#8595a8] focus:outline-none focus:border-[#15B7AE] w-60" />
          </div>
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)}
            className="px-3 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm text-[#34568a] focus:outline-none focus:border-[#15B7AE]">
            {assignees.map((a) => <option key={a} value={a}>{a === "All" ? "All assigned" : a}</option>)}
          </select>
          <select value={versionFilter} onChange={(e) => setVersionFilter(e.target.value)}
            className="px-3 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm text-[#34568a] focus:outline-none focus:border-[#15B7AE]">
            <option value="All">All versions</option>
            <option value="V3">V3</option>
            <option value="V2.3">V2.3</option>
          </select>
          <select value={sortMode} onChange={(e) => setSortMode(e.target.value as typeof sortMode)}
            title="Funnel Health = combined score of Leads/Dep 30, Leads/Dep 14, Conv% 30, Conv% 14 (same color bands as the cells)"
            className={cn("px-3 py-2 border rounded-lg text-sm focus:outline-none focus:border-[#15B7AE]",
              sortMode === "default" ? "bg-white border-[#e4ebf2] text-[#34568a]" : "bg-[#e6f7f5] border-[#a7e3df] text-[#0e8f88] font-semibold")}>
            <option value="default">Sort: Deposits</option>
            <option value="fh-best">Funnel Health: best → worst</option>
            <option value="fh-worst">Funnel Health: worst → best</option>
          </select>

          {/* Duplicate-deposit tracker */}
          <div className="relative">
            <button onClick={() => setDupOpen((o) => !o)}
              className={cn("flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm border transition-colors",
                dups.length ? "bg-[#fff4ed] border-[#fbcfae] text-[#c2410c] hover:bg-[#ffe9da]" : "bg-white border-[#e4ebf2] text-[#697a91] hover:border-[#cbd5e1]")}>
              <Copy size={14} />
              Duplicates
              {dups.length > 0 && <span className="ml-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-[#ea580c] text-white">{dups.length}</span>}
            </button>
            {dupOpen && (
              <div className="absolute right-0 mt-1.5 z-40 w-[440px] max-h-[440px] overflow-auto rounded-xl border border-[#e4ebf2] bg-white p-3 space-y-2" style={{ boxShadow: "0 10px 30px -8px rgba(0,0,0,0.25)" }}>
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-[#1f3559]">Duplicate deposits ({dups.length})</h3>
                  <button onClick={() => setDupOpen(false)} className="text-[#94a3b8] hover:text-[#1e2a3a]"><X size={15} /></button>
                </div>
                <p className="text-[11px] text-[#697a91] leading-snug">Same contact with more than one deposit for a client. These are <strong>counted once</strong> in the table — remove the extra deposit at the source to clean it up.</p>
                {dups.length === 0 ? (
                  <p className="text-xs text-[#8595a8] py-3 text-center">No duplicate deposits 🎉</p>
                ) : (
                  <ul className="space-y-1.5">
                    {dups.map((d, i) => (
                      <li key={i} className="rounded-lg border border-[#eef3f8] bg-[#fafcfe] px-2.5 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium text-[#1f3559] truncate">{d.full_name || d.email || "—"}</span>
                          <span className="shrink-0 px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-[#fde8d6] text-[#c2410c]">{d.deposit_count}×</span>
                        </div>
                        <div className="text-[11px] text-[#697a91] truncate">{d.owner_name}{d.email ? ` · ${d.email}` : ""}</div>
                        {d.dates && <div className="text-[10px] text-[#8595a8] mt-0.5 break-words">{d.dates}</div>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <span className="text-xs text-[#697a91]">{filtered.length} clients</span>
        </div>
      </div>

      {error ? (
        <div className="px-4 py-3 rounded-lg border border-[#f5c2cf] bg-[#fde8ee] text-[#e11d48] text-sm"><strong>Error:</strong> {error}</div>
      ) : loading ? (
        <div className="text-sm text-[#697a91] py-12 text-center">Loading…</div>
      ) : (
        <>
        {/* Mobile: cards */}
        <div className="md:hidden space-y-2">
          {filtered.map((r, i) => {
            const id = String(r.sheet_row ?? i);
            return <DepositCard key={id} r={r} open={openRow === id} hasGhl={ghlKeys.has((r.owner_name ?? "").toLowerCase().trim())} showHealth={sortMode !== "default"} onToggle={() => setOpenRow(openRow === id ? null : id)} />;
          })}
          {filtered.length === 0 && <div className="px-4 py-12 text-center text-[#8595a8]">No clients match.</div>}
        </div>
        {/* Desktop: table */}
        <div className="hidden md:block rounded-[14px] border border-[#e4ebf2] bg-white overflow-auto max-h-[calc(100vh-180px)]" style={{ boxShadow: "var(--shadow-sm)" }}>
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>
                {HEADERS.map((h, idx) => {
                  const divider = idx === 8 || idx === 12 || idx === 16 || idx === 20 || idx === 22 || idx === 25; // after Deposit $, D 3, L 3, No-Dep 14, Conv% 14, CPD 7
                  return (
                    <th key={h} className={cn("sticky top-0 px-3 py-2.5 text-left text-[10px] font-bold uppercase tracking-wider whitespace-nowrap text-white",
                      idx === 0 || idx === 1 ? "z-30" : "z-20", divider && "border-r-2 border-[#9fb0c4]")}
                      style={{ background: "#2d4c79",
                        ...(idx === 0 && { left: 0, width: 180, minWidth: 180, maxWidth: 180 }),
                        ...(idx === 1 && { left: 180, width: 160, minWidth: 160, maxWidth: 160, boxShadow: "2px 0 0 0 #cbd5e1, 6px 0 8px -6px rgba(0,0,0,0.30)" }) }}>
                      {h}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => {
                const cpd30 = num(r.cpd30), cpd14 = num(r.cpd14), cpd7 = num(r.cpd7);
                const conv30 = r.l30 && r.l30 > 0 ? (r.d30 / r.l30) * 100 : null;
                const conv14 = r.l14 && r.l14 > 0 ? (r.d14 / r.l14) * 100 : null;
                // Book rate: booked / GHL leads (same data source for both sides)
                const book30 = r.gl30 && r.gl30 > 0 && r.b30 != null ? (r.b30 / r.gl30) * 100 : null;
                const book14 = r.gl14 && r.gl14 > 0 && r.b14 != null ? (r.b14 / r.gl14) * 100 : null;
                const paused = String(r.client_status ?? "").toLowerCase() === "paused";
                const rowBgClass = paused ? "bg-[#e2e5ea] text-[#7c8794]" : i % 2 ? "bg-[#fafcfe]" : "bg-white";
                const rowId = String(r.sheet_row ?? i);
                const isOpen = openRow === rowId;
                const hasGhl = ghlKeys.has((r.owner_name ?? "").toLowerCase().trim());
                return (
                  <Fragment key={rowId}>
                  <tr className={cn("group border-b border-[#eef3f8]", rowBgClass, "hover:bg-[#a7e3df]")}>
                    <td className={cn("sticky left-0 z-10 px-3 py-2 text-[#1f3559] font-medium whitespace-nowrap overflow-hidden text-ellipsis group-hover:bg-[#a7e3df] cursor-pointer select-none", rowBgClass)}
                      style={{ left: 0, width: 180, minWidth: 180, maxWidth: 180 }} title="Click to view / add activity"
                      onClick={() => setOpenRow(isOpen ? null : rowId)}>
                      <ChevronRight size={13} className={cn("inline-block -ml-0.5 mr-0.5 transition-transform align-[-2px]", isOpen && "rotate-90", hasGhl ? "text-[#94a3b8]" : "text-[#ea580c]")} />
                      {sortMode !== "default" && (() => { const h = funnelHealth(r); const t = healthTone(h); return (
                        <span className="inline-block w-2.5 h-2.5 rounded-full mr-1.5 align-[-1px] border border-black/10"
                          style={{ background: t.bg }}
                          title={h == null ? "Funnel Health: no lead data" : `Funnel Health score: ${h.toFixed(1)} / 3`} />
                      ); })()}
                      <span className={cn(!hasGhl && "text-[#ea580c]")} title={hasGhl ? undefined : "No GHL conversation data — key missing or not ingested yet"}>{r.owner_name || "—"}</span>
                      {!hasGhl && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-[#fff1e8] text-[#ea580c] border border-[#fed0b0]" title="No GHL conversation data yet">No GHL</span>}
                      {paused && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-[#fff7ec] text-[#d97706] border border-[#fcd9a8]">Paused</span>}
                    </td>
                    <td className={cn("sticky z-10 px-3 py-2 text-[#34568a] whitespace-nowrap overflow-hidden text-ellipsis group-hover:bg-[#a7e3df]", rowBgClass)}
                      style={{ left: 180, width: 160, minWidth: 160, maxWidth: 160, boxShadow: "2px 0 0 0 #cbd5e1, 6px 0 8px -6px rgba(0,0,0,0.20)" }} title={r.ad_account_name ?? ""}>{r.ad_account_name || "—"}</td>
                    <td className="px-3 py-2 text-[#1e2a3a] whitespace-nowrap">{money0(r.daily_budget)}</td>
                    <td className="px-3 py-2"><UserCell name={r.assigned} /></td>
                    <td className="px-3 py-2"><UserCell name={r.media_buyer} /></td>
                    <td className="px-3 py-2 whitespace-nowrap text-[#8595a8] line-through">{r.original_price || "—"}</td>
                    <td className="px-3 py-2 font-semibold text-[#0e8f88]"><ExpandText value={r.discounted_price} /></td>
                    <td className="px-3 py-2 max-w-[130px] truncate text-[#34568a]" title={r.current_offer ?? ""}>{r.current_offer || <span className="text-[#a6b3c4]">—</span>}</td>
                    <td className="px-3 py-2 whitespace-nowrap font-semibold text-[#1e2a3a] border-r-2 border-[#cbd5e1]">{r.deposit_amount || <span className="text-[#a6b3c4]">—</span>}</td>
                    <td className="px-3 py-2 text-center font-bold" style={{ background: depCellTone(r.d30, 8, 3, paused).bg, color: depCellTone(r.d30, 8, 3, paused).fg }}>{r.d30}</td>
                    <td className="px-3 py-2 text-center font-bold" style={{ background: depCellTone(r.d14, 5, 2, paused).bg, color: depCellTone(r.d14, 5, 2, paused).fg }}>{r.d14}</td>
                    <td className="px-3 py-2 text-center font-bold" style={{ background: depCellTone(r.d7, 3, 1, paused).bg, color: depCellTone(r.d7, 3, 1, paused).fg }}>{r.d7}</td>
                    <td className="px-3 py-2 text-center font-bold border-r-2 border-[#cbd5e1]" style={{ background: depCellTone(r.d3, 2, 1, paused).bg, color: depCellTone(r.d3, 2, 1, paused).fg }}>{r.d3}</td>
                    <td className="px-3 py-2 text-center font-semibold text-[#1e2a3a] whitespace-nowrap">{r.l30 ?? 0}</td>
                    <td className="px-3 py-2 text-center font-semibold text-[#1e2a3a] whitespace-nowrap">{r.l14 ?? 0}</td>
                    <td className="px-3 py-2 text-center font-semibold text-[#1e2a3a] whitespace-nowrap">{r.l7 ?? 0}</td>
                    <td className="px-3 py-2 text-center font-semibold text-[#1e2a3a] whitespace-nowrap border-r-2 border-[#cbd5e1]">{r.l3 ?? 0}</td>
                    <td className="px-3 py-2 text-center font-semibold whitespace-nowrap" style={{ background: bookTone(book30).bg, color: bookTone(book30).fg }} title={book30 == null ? "No GHL lead data" : `${r.b30} of ${r.gl30} leads picked a date/time (30d)`}>{book30 == null ? "—" : `${Math.round(book30)}%`}</td>
                    <td className="px-3 py-2 text-center font-semibold whitespace-nowrap" style={{ background: bookTone(book14).bg, color: bookTone(book14).fg }} title={book14 == null ? "No GHL lead data" : `${r.b14} of ${r.gl14} leads picked a date/time (14d)`}>{book14 == null ? "—" : `${Math.round(book14)}%`}</td>
                    <td className="px-3 py-2 text-center font-semibold whitespace-nowrap" style={{ background: noDepTone(r.b30, r.bnd30).bg, color: noDepTone(r.b30, r.bnd30).fg }} title={r.b30 == null ? "No GHL lead data" : `${r.bnd30} of ${r.b30} booked never paid the deposit (30d)`}>{r.bnd30 == null ? "—" : r.bnd30}</td>
                    <td className="px-3 py-2 text-center font-semibold whitespace-nowrap border-r-2 border-[#cbd5e1]" style={{ background: noDepTone(r.b14, r.bnd14).bg, color: noDepTone(r.b14, r.bnd14).fg }} title={r.b14 == null ? "No GHL lead data" : `${r.bnd14} of ${r.b14} booked never paid the deposit (14d)`}>{r.bnd14 == null ? "—" : r.bnd14}</td>
                    <td className="px-3 py-2 text-center font-semibold whitespace-nowrap" style={{ background: convTone(conv30).bg, color: convTone(conv30).fg }} title={conv30 == null ? "No leads in 30d" : `${r.d30} deposits / ${r.l30} leads (30d)`}>{conv30 == null ? "—" : conv30.toFixed(1) + "%"}</td>
                    <td className="px-3 py-2 text-center font-semibold whitespace-nowrap border-r-2 border-[#cbd5e1]" style={{ background: convTone(conv14).bg, color: convTone(conv14).fg }} title={conv14 == null ? "No leads in 14d" : `${r.d14} deposits / ${r.l14} leads (14d)`}>{conv14 == null ? "—" : conv14.toFixed(1) + "%"}</td>
                    <td className="px-3 py-2 text-center font-semibold whitespace-nowrap" style={{ background: cpdVivid(cpd30).bg, color: cpdVivid(cpd30).fg }}>{cpd30 == null ? "—" : formatCurrency(cpd30)}</td>
                    <td className="px-3 py-2 text-center font-semibold whitespace-nowrap" style={{ background: cpdVivid(cpd14).bg, color: cpdVivid(cpd14).fg }}>{cpd14 == null ? "—" : formatCurrency(cpd14)}</td>
                    <td className="px-3 py-2 text-center font-semibold whitespace-nowrap border-r-2 border-[#cbd5e1]" style={{ background: cpdVivid(cpd7).bg, color: cpdVivid(cpd7).fg }}>{cpd7 == null ? "—" : formatCurrency(cpd7)}</td>
                    <td className="px-3 py-2 text-[#1e2a3a] whitespace-nowrap">{num(r.spent30) != null ? formatCurrency(num(r.spent30)) : "—"}</td>
                    <td className="px-3 py-2 text-[#1e2a3a] whitespace-nowrap">{num(r.spent14) != null ? formatCurrency(num(r.spent14)) : "—"}</td>
                    <td className="px-3 py-2 text-[#1e2a3a] whitespace-nowrap">{num(r.spent7) != null ? formatCurrency(num(r.spent7)) : "—"}</td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-[#f3f7fb]">
                      <td colSpan={HEADERS.length} className="p-0 border-b border-[#e4ebf2]">
                        <div className="sticky left-0 p-3 space-y-3" style={{ width: "min(1000px, 100vw - 2rem)" }}>
                          <div className="rounded-xl border border-[#e4ebf2] bg-white p-4 shadow-sm">
                            <h3 className="text-sm font-semibold text-[#1f3559] mb-2">V3 Leads &amp; Conversations</h3>
                            <LeadBreakdown ownerKey={(r.owner_name ?? "").toLowerCase().trim()} />
                          </div>
                          <ActivityLog clientKey={(r.owner_name ?? "").toLowerCase().trim()} clientLabel={r.owner_name ?? undefined} />
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={HEADERS.length} className="px-4 py-12 text-center text-[#8595a8]">No V3 clients match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        </>
      )}
    </div>
  );
}

// Mobile card for one Cost/Deposit row (deposits + conversion, tap to expand).
function DepositCard({ r, open, hasGhl, showHealth, onToggle }: { r: Row; open: boolean; hasGhl: boolean; showHealth?: boolean; onToggle: () => void }) {
  const cpd30 = num(r.cpd30);
  const conv30 = r.l30 && r.l30 > 0 ? (r.d30 / r.l30) * 100 : null;
  const book30 = r.gl30 && r.gl30 > 0 && r.b30 != null ? (r.b30 / r.gl30) * 100 : null;
  const paused = String(r.client_status ?? "").toLowerCase() === "paused";
  const health = showHealth ? funnelHealth(r) : null;
  const chip = (label: string, val: string | number, tone?: { bg: string; fg: string }) => (
    <div className="rounded-lg px-2 py-1.5 text-center" style={tone ? { background: tone.bg, color: tone.fg } : { background: "#f1f5f9", color: "#1f3559" }}>
      <div className="text-[9px] font-bold uppercase tracking-wide opacity-70">{label}</div>
      <div className="text-sm font-bold">{val}</div>
    </div>
  );
  return (
    <div className="rounded-xl border border-[#e4ebf2] bg-white overflow-hidden">
      <button onClick={onToggle} className="w-full flex items-start gap-2 p-3 text-left">
        <ChevronRight size={15} className={cn("mt-0.5 shrink-0 transition-transform", open && "rotate-90", hasGhl ? "text-[#94a3b8]" : "text-[#ea580c]")} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            {showHealth && (
              <span className="inline-block w-2.5 h-2.5 rounded-full border border-black/10 shrink-0"
                style={{ background: healthTone(health).bg }}
                title={health == null ? "Funnel Health: no lead data" : `Funnel Health score: ${health.toFixed(1)} / 3`} />
            )}
            <span className={cn("font-bold", hasGhl ? "text-[#1f3559]" : "text-[#ea580c]")}>{r.owner_name || "—"}</span>
            {!hasGhl && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-[#fff1e8] text-[#ea580c] border border-[#fed0b0]">No GHL</span>}
            {paused && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-[#fff7ec] text-[#d97706] border border-[#fcd9a8]">Paused</span>}
          </div>
          <div className="text-xs text-[#697a91] truncate">{r.ad_account_name || "—"}</div>
        </div>
      </button>
      <div className="px-3 pb-3 grid grid-cols-4 gap-1.5">
        {chip("D 30", r.d30, depCellTone(r.d30, 8, 3, paused))}
        {chip("D 14", r.d14, depCellTone(r.d14, 5, 2, paused))}
        {chip("D 7", r.d7, depCellTone(r.d7, 3, 1, paused))}
        {chip("D 3", r.d3, depCellTone(r.d3, 2, 1, paused))}
        {chip("L 30", r.l30 ?? 0)}
        {chip("L 7", r.l7 ?? 0)}
        {chip("Book% 30", book30 == null ? "—" : `${Math.round(book30)}%`, bookTone(book30))}
        {chip("No-Dep 30", r.bnd30 == null ? "—" : r.bnd30, noDepTone(r.b30, r.bnd30))}
        {chip("Conv 30", conv30 == null ? "—" : `${conv30.toFixed(0)}%`, convTone(conv30))}
        {chip("CPD 30", cpd30 == null ? "—" : formatCurrency(cpd30), cpdVivid(cpd30))}
        {chip("Spent", num(r.spent30) != null ? formatCurrency(num(r.spent30)) : "—")}
        {chip("Budget", money0(r.daily_budget))}
      </div>
      {open && (
        <div className="px-3 pb-3 space-y-3 border-t border-[#eef3f8] pt-3">
          <div className="rounded-xl border border-[#e4ebf2] bg-white p-3">
            <h3 className="text-sm font-semibold text-[#1f3559] mb-2">V3 Leads &amp; Conversations</h3>
            <LeadBreakdown ownerKey={(r.owner_name ?? "").toLowerCase().trim()} />
          </div>
          <ActivityLog clientKey={(r.owner_name ?? "").toLowerCase().trim()} clientLabel={r.owner_name ?? undefined} />
        </div>
      )}
    </div>
  );
}
