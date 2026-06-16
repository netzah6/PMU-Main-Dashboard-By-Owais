"use client";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatCurrency, userColor, cn } from "@/lib/utils";
import { Search } from "lucide-react";

interface Row {
  sheet_row: number;
  owner_name: string | null;
  ad_account_name: string | null;
  version: string | null;
  assigned: string | null;
  media_buyer: string | null;
  original_price: string | null;
  discounted_price: string | null;
  offer: string | null;
  current_offer: string | null;
  daily_budget: number | string | null;
  d3: number; d7: number; d14: number; d30: number;
  spent7: number | string | null; spent14: number | string | null; spent30: number | string | null;
  cpd7: number | string | null; cpd14: number | string | null; cpd30: number | string | null;
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
// Cost per deposit: lower is better; $0 / none = gray
const cpdVivid = (v: number | null): Vivid =>
  v == null || v <= 0 ? V.gray : v < 75 ? V.green : v < 150 ? V.yellow : v < 250 ? V.orange : V.red;

function UserCell({ name }: { name: string | null }) {
  if (!name) return <span className="text-[#a6b3c4]">—</span>;
  const c = userColor(name);
  return (
    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap border"
      style={{ background: c?.bg, color: c?.text, borderColor: c?.border }}>{name}</span>
  );
}

const HEADERS = ["Owner Name", "Ad Account Name", "Daily Budget", "Assigned", "Media Buyer", "Original $", "Discounted $", "Current Offer", "D 30", "D 14", "D 7", "D 3", "CPD 30", "CPD 14", "CPD 7", "Spent 30", "Spent 14", "Spent 7"];

export default function CostPerDepositPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [assignee, setAssignee] = useState("All");

  useEffect(() => {
    const supabase = createClient();
    (async () => {
      const { data, error } = await supabase.from("deposit_overview").select("*");
      if (error) { setError(error.message); setLoading(false); return; }
      setRows((data as Row[]) ?? []);
      setLoading(false);
    })();
  }, []);

  const assignees = useMemo(() => ["All", ...Array.from(new Set(rows.map((r) => r.assigned).filter(Boolean) as string[])).sort()], [rows]);

  const filtered = useMemo(() => {
    const list = rows.filter((r) => {
      if (assignee !== "All" && r.assigned !== assignee) return false;
      if (search && !`${r.owner_name ?? ""} ${r.ad_account_name ?? ""}`.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
    return list.sort((a, b) => b.d30 - a.d30);
  }, [rows, search, assignee]);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-semibold text-[#1f3559]">Cost Per Deposit</h1>
          <p className="text-xs text-[#697a91]">V3 clients · deposits & cost-per-deposit</p>
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
          <span className="text-xs text-[#697a91]">{filtered.length} V3 clients</span>
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
                  const divider = idx === 7 || idx === 11 || idx === 14; // after Current Offer, D 3, CPD 7
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
                const rowBgClass = i % 2 ? "bg-[#fafcfe]" : "bg-white";
                return (
                  <tr key={r.sheet_row ?? i} className={cn("group border-b border-[#eef3f8]", rowBgClass, "hover:bg-[#a7e3df]")}>
                    <td className={cn("sticky left-0 z-10 px-3 py-2 text-[#1f3559] font-medium whitespace-nowrap overflow-hidden text-ellipsis group-hover:bg-[#a7e3df]", rowBgClass)}
                      style={{ left: 0, width: 180, minWidth: 180, maxWidth: 180 }} title={r.owner_name ?? ""}>{r.owner_name || "—"}</td>
                    <td className={cn("sticky z-10 px-3 py-2 text-[#34568a] whitespace-nowrap overflow-hidden text-ellipsis group-hover:bg-[#a7e3df]", rowBgClass)}
                      style={{ left: 180, width: 160, minWidth: 160, maxWidth: 160, boxShadow: "2px 0 0 0 #cbd5e1, 6px 0 8px -6px rgba(0,0,0,0.20)" }} title={r.ad_account_name ?? ""}>{r.ad_account_name || "—"}</td>
                    <td className="px-3 py-2 text-[#1e2a3a] whitespace-nowrap">{money0(r.daily_budget)}</td>
                    <td className="px-3 py-2"><UserCell name={r.assigned} /></td>
                    <td className="px-3 py-2"><UserCell name={r.media_buyer} /></td>
                    <td className="px-3 py-2 whitespace-nowrap text-[#8595a8] line-through">{r.original_price || "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap font-semibold text-[#0e8f88]" title={r.offer ?? ""}>{r.discounted_price || "—"}</td>
                    <td className="px-3 py-2 max-w-[220px] truncate border-r-2 border-[#cbd5e1] text-[#34568a]" title={r.current_offer ?? ""}>{r.current_offer || <span className="text-[#a6b3c4]">—</span>}</td>
                    <td className="px-3 py-2 text-center font-bold" style={{ background: depVivid(r.d30, 8, 3).bg, color: depVivid(r.d30, 8, 3).fg }}>{r.d30}</td>
                    <td className="px-3 py-2 text-center font-bold" style={{ background: depVivid(r.d14, 5, 2).bg, color: depVivid(r.d14, 5, 2).fg }}>{r.d14}</td>
                    <td className="px-3 py-2 text-center font-bold" style={{ background: depVivid(r.d7, 3, 1).bg, color: depVivid(r.d7, 3, 1).fg }}>{r.d7}</td>
                    <td className="px-3 py-2 text-center font-bold border-r-2 border-[#cbd5e1]" style={{ background: depVivid(r.d3, 2, 1).bg, color: depVivid(r.d3, 2, 1).fg }}>{r.d3}</td>
                    <td className="px-3 py-2 text-center font-semibold whitespace-nowrap" style={{ background: cpdVivid(cpd30).bg, color: cpdVivid(cpd30).fg }}>{cpd30 == null ? "—" : formatCurrency(cpd30)}</td>
                    <td className="px-3 py-2 text-center font-semibold whitespace-nowrap" style={{ background: cpdVivid(cpd14).bg, color: cpdVivid(cpd14).fg }}>{cpd14 == null ? "—" : formatCurrency(cpd14)}</td>
                    <td className="px-3 py-2 text-center font-semibold whitespace-nowrap border-r-2 border-[#cbd5e1]" style={{ background: cpdVivid(cpd7).bg, color: cpdVivid(cpd7).fg }}>{cpd7 == null ? "—" : formatCurrency(cpd7)}</td>
                    <td className="px-3 py-2 text-[#1e2a3a] whitespace-nowrap">{num(r.spent30) != null ? formatCurrency(num(r.spent30)) : "—"}</td>
                    <td className="px-3 py-2 text-[#1e2a3a] whitespace-nowrap">{num(r.spent14) != null ? formatCurrency(num(r.spent14)) : "—"}</td>
                    <td className="px-3 py-2 text-[#1e2a3a] whitespace-nowrap">{num(r.spent7) != null ? formatCurrency(num(r.spent7)) : "—"}</td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={18} className="px-4 py-12 text-center text-[#8595a8]">No V3 clients match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
