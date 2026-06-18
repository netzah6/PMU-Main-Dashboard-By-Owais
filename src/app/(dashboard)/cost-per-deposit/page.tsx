"use client";
import { Fragment, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatCurrency, userColor, cn } from "@/lib/utils";
import { Search, ChevronRight, Copy, X } from "lucide-react";
import { ActivityLog } from "@/components/activity/ActivityLog";

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
// Leads per deposit (1/N): fewer leads per deposit is better; no deposits = gray
const ratioTone = (v: number | null): Vivid =>
  v == null ? V.gray : v <= 10 ? V.green : v <= 18 ? V.yellow : v <= 30 ? V.orange : V.red;
// Lead→deposit conversion %: higher is better; no leads = gray (mirrors ratioTone bands)
const convTone = (v: number | null): Vivid =>
  v == null ? V.gray : v >= 10 ? V.green : v >= 5.5 ? V.yellow : v >= 3.3 ? V.orange : V.red;

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

const HEADERS = ["Owner Name", "Ad Account Name", "Daily Budget", "Assigned", "Media Buyer", "Original $", "Discounted $", "Current Offer", "Deposit $", "D 30", "D 14", "D 7", "D 3", "Leads/Dep 30", "Leads/Dep 14", "Conv% 30", "Conv% 14", "CPD 30", "CPD 14", "CPD 7", "Spent 30", "Spent 14", "Spent 7"];

export default function CostPerDepositPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [assignee, setAssignee] = useState("All");
  const [versionFilter, setVersionFilter] = useState("All");
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [dups, setDups] = useState<Dup[]>([]);
  const [dupOpen, setDupOpen] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    (async () => {
      const { data, error } = await supabase.from("deposit_overview").select("*");
      if (error) { setError(error.message); setLoading(false); return; }
      setRows((data as Row[]) ?? []);
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
    // Live clients first (by 30-day deposits), Paused sink to the bottom.
    const rank = (s: string | null) => (String(s ?? "").toLowerCase() === "paused" ? 1 : 0);
    return list.sort((a, b) => rank(a.client_status) - rank(b.client_status) || b.d30 - a.d30);
  }, [rows, search, assignee, versionFilter]);

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
        <div className="rounded-[14px] border border-[#e4ebf2] bg-white overflow-auto max-h-[calc(100vh-180px)]" style={{ boxShadow: "var(--shadow-sm)" }}>
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>
                {HEADERS.map((h, idx) => {
                  const divider = idx === 8 || idx === 12 || idx === 14 || idx === 16 || idx === 19; // after Deposit $, D 3, Leads/Dep 14, Conv% 14, CPD 7
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
                const ratio30 = r.d30 > 0 ? Math.round((r.l30 ?? 0) / r.d30) : null;
                const ratio14 = r.d14 > 0 ? Math.round((r.l14 ?? 0) / r.d14) : null;
                const conv30 = r.l30 && r.l30 > 0 ? (r.d30 / r.l30) * 100 : null;
                const conv14 = r.l14 && r.l14 > 0 ? (r.d14 / r.l14) * 100 : null;
                const paused = String(r.client_status ?? "").toLowerCase() === "paused";
                const rowBgClass = paused ? "bg-[#e2e5ea] text-[#7c8794]" : i % 2 ? "bg-[#fafcfe]" : "bg-white";
                const rowId = String(r.sheet_row ?? i);
                const isOpen = openRow === rowId;
                return (
                  <Fragment key={rowId}>
                  <tr className={cn("group border-b border-[#eef3f8]", rowBgClass, "hover:bg-[#a7e3df]")}>
                    <td className={cn("sticky left-0 z-10 px-3 py-2 text-[#1f3559] font-medium whitespace-nowrap overflow-hidden text-ellipsis group-hover:bg-[#a7e3df] cursor-pointer select-none", rowBgClass)}
                      style={{ left: 0, width: 180, minWidth: 180, maxWidth: 180 }} title="Click to view / add activity"
                      onClick={() => setOpenRow(isOpen ? null : rowId)}>
                      <ChevronRight size={13} className={cn("inline-block -ml-0.5 mr-0.5 text-[#94a3b8] transition-transform align-[-2px]", isOpen && "rotate-90")} />
                      {r.owner_name || "—"}
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
                    <td className="px-3 py-2 text-center font-semibold whitespace-nowrap" style={{ background: ratioTone(ratio30).bg, color: ratioTone(ratio30).fg }} title={r.d30 > 0 ? `${r.l30 ?? 0} leads / ${r.d30} deposits (30d)` : "No deposits in 30d"}>{ratio30 == null ? "—" : `1/${ratio30}`}</td>
                    <td className="px-3 py-2 text-center font-semibold whitespace-nowrap border-r-2 border-[#cbd5e1]" style={{ background: ratioTone(ratio14).bg, color: ratioTone(ratio14).fg }} title={r.d14 > 0 ? `${r.l14 ?? 0} leads / ${r.d14} deposits (14d)` : "No deposits in 14d"}>{ratio14 == null ? "—" : `1/${ratio14}`}</td>
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
                        <div className="sticky left-0 p-3" style={{ width: "min(960px, 100vw - 2rem)" }}>
                          <ActivityLog clientKey={(r.owner_name ?? "").toLowerCase().trim()} clientLabel={r.owner_name ?? undefined} />
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={23} className="px-4 py-12 text-center text-[#8595a8]">No V3 clients match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
