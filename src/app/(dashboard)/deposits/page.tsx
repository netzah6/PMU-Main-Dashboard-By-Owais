"use client";
import { useState, useMemo } from "react";
import { useTableData } from "@/lib/hooks/useTableData";
import { useUser } from "@/lib/hooks/useUser";
import { AutoTable } from "@/components/ui/AutoTable";
import { sortNewestFirst, cn } from "@/lib/utils";
import { Search, Copy, X } from "lucide-react";

type Row = Record<string, unknown>;

// Deposit date lives in `f` — mixed ISO timestamps and DD/MM/YYYY.
function parseDepositDate(f: string): Date | null {
  if (!f) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(f)) { const d = new Date(f); return isNaN(d.getTime()) ? null : d; }
  const m = f.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) { const day = +m[1], mon = +m[2], yr = +m[3]; if (mon >= 1 && mon <= 12) return new Date(yr, mon - 1, day); }
  return null;
}
const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const monthLabel = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
};
const depDate = (r: Row) => parseDepositDate(String(r["f"] ?? r["Date"] ?? r["date"] ?? ""));
const contactKey = (r: Row) => String(r["Email"] ?? "").trim().toLowerCase() || String(r["Full Name"] ?? "").trim().toLowerCase();
const fmtDate = (f: string) => { const d = parseDepositDate(f); return d ? d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : f; };

export default function DepositsPage() {
  const { data, loading, error } = useTableData<Row>({ table: "deposits" });
  const { role } = useUser();
  const [search, setSearch] = useState("");
  const [month, setMonth] = useState("All");
  const [dupOpen, setDupOpen] = useState(false);

  const months = useMemo(() => {
    const set = new Set<string>();
    data.forEach((r) => { const d = depDate(r); if (d) set.add(monthKey(d)); });
    return Array.from(set).sort().reverse();
  }, [data]);

  const filtered = useMemo(() => {
    return sortNewestFirst(data.filter((r) => {
      const hay = `${r["Business Name"] ?? r.client_name ?? ""} ${r["Full Name"] ?? ""} ${r["Email"] ?? ""}`.toLowerCase();
      if (search && !hay.includes(search.toLowerCase())) return false;
      if (month !== "All") { const d = depDate(r); if (!d || monthKey(d) !== month) return false; }
      return true;
    }));
  }, [data, search, month]);

  // Duplicate deposits: same client + same contact (email or name) more than once.
  const dups = useMemo(() => {
    const map = new Map<string, { business: string; name: string; email: string; dates: string[] }>();
    data.forEach((r) => {
      const c = contactKey(r); if (!c) return;
      const biz = String(r["Business Name"] ?? "").trim(); if (!biz) return;
      const key = biz.toLowerCase() + "|" + c;
      const e = map.get(key) ?? { business: biz, name: String(r["Full Name"] ?? ""), email: String(r["Email"] ?? ""), dates: [] };
      e.dates.push(String(r["f"] ?? ""));
      map.set(key, e);
    });
    return Array.from(map.values()).filter((d) => d.dates.length > 1).sort((a, b) => b.dates.length - a.dates.length);
  }, [data]);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-lg font-semibold text-[#1f3559]">Deposits</h1>
        {/* Total count — admins only */}
        {role === "admin" && (
          <div className="bg-white rounded-lg px-4 py-2 border border-[#e4ebf2] text-right">
            <p className="text-xs text-[#697a91]">Total deposits{month !== "All" ? ` · ${monthLabel(month)}` : ""}</p>
            <p className="text-[#0e8f88] font-bold text-lg">{filtered.length.toLocaleString()}</p>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#697a91]" />
          <input type="text" placeholder="Search client, name, or email…" value={search} onChange={(e) => setSearch(e.target.value)}
            className="pl-8 pr-3 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm text-[#1f3559] placeholder:text-[#8595a8] focus:outline-none focus:border-[#15B7AE]" />
        </div>
        <select value={month} onChange={(e) => setMonth(e.target.value)}
          className="px-3 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm text-[#34568a] focus:outline-none focus:border-[#15B7AE]">
          <option value="All">All months</option>
          {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
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
            <div className="absolute left-0 mt-1.5 z-40 w-[calc(100vw-3rem)] sm:w-[440px] max-h-[440px] overflow-auto rounded-xl border border-[#e4ebf2] bg-white p-3 space-y-2" style={{ boxShadow: "0 10px 30px -8px rgba(0,0,0,0.25)" }}>
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-[#1f3559]">Duplicate deposits ({dups.length})</h3>
                <button onClick={() => setDupOpen(false)} className="text-[#94a3b8] hover:text-[#1e2a3a]"><X size={15} /></button>
              </div>
              <p className="text-[11px] text-[#697a91] leading-snug">Same contact with more than one deposit for a client. Remove the extra deposit at the source to clean it up.</p>
              {dups.length === 0 ? (
                <p className="text-xs text-[#8595a8] py-3 text-center">No duplicate deposits 🎉</p>
              ) : (
                <ul className="space-y-1.5">
                  {dups.map((d, i) => (
                    <li key={i} className="rounded-lg border border-[#eef3f8] bg-[#fafcfe] px-2.5 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-[#1f3559] truncate">{d.name || d.email || "—"}</span>
                        <span className="shrink-0 px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-[#fde8d6] text-[#c2410c]">{d.dates.length}×</span>
                      </div>
                      <div className="text-[11px] text-[#697a91] truncate">{d.business}{d.email ? ` · ${d.email}` : ""}</div>
                      <div className="text-[10px] text-[#8595a8] mt-0.5">{d.dates.map(fmtDate).join(" · ")}</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      <AutoTable data={filtered} loading={loading} error={error} exportFilename="deposits.csv" />
    </div>
  );
}
