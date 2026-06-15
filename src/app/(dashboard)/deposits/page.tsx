"use client";
import { useState, useMemo } from "react";
import { useTableData } from "@/lib/hooks/useTableData";
import { AutoTable } from "@/components/ui/AutoTable";
import { formatCurrency, sortNewestFirst } from "@/lib/utils";
import { Search } from "lucide-react";

export default function DepositsPage() {
  const { data, loading, error } = useTableData<Record<string, unknown>>({ table: "deposits" });
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const filtered = useMemo(() => {
    return sortNewestFirst(data.filter((r) => {
      const name = String(r["Business Name"] ?? r.client_name ?? "").toLowerCase();
      const date = String(r["Date"] ?? r.date ?? "");
      if (search && !name.includes(search.toLowerCase())) return false;
      if (dateFrom && date && date < dateFrom) return false;
      if (dateTo && date && date > dateTo) return false;
      return true;
    }));
  }, [data, search, dateFrom, dateTo]);

  const total = useMemo(() => filtered.reduce((s, r) => {
    const v = parseFloat(String(r["Amount"] ?? r.amount ?? "").replace(/[$,]/g, ""));
    return s + (isNaN(v) ? 0 : v);
  }, 0), [filtered]);

  const thisMonth = useMemo(() => {
    const now = new Date();
    return filtered.filter((r) => {
      const d = new Date(String(r["Date"] ?? r.date ?? ""));
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    }).reduce((s, r) => {
      const v = parseFloat(String(r["Amount"] ?? r.amount ?? "").replace(/[$,]/g, ""));
      return s + (isNaN(v) ? 0 : v);
    }, 0);
  }, [filtered]);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-lg font-semibold text-[#1f3559]">Deposits</h1>
        <div className="flex gap-3 text-sm">
          <div className="bg-white rounded-lg px-4 py-2 border border-[#e4ebf2]">
            <p className="text-xs text-[#697a91]">Total</p>
            <p className="text-[#0e8f88] font-semibold">{formatCurrency(total)}</p>
          </div>
          <div className="bg-white rounded-lg px-4 py-2 border border-[#e4ebf2]">
            <p className="text-xs text-[#697a91]">This Month</p>
            <p className="text-[#0e8f88] font-semibold">{formatCurrency(thisMonth)}</p>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#697a91]" />
          <input type="text" placeholder="Search client…" value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 pr-3 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm text-[#1f3559] placeholder:text-[#8595a8] focus:outline-none focus:border-[#15B7AE]" />
        </div>
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
          className="px-3 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm text-[#34568a] focus:outline-none focus:border-[#15B7AE]" />
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
          className="px-3 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm text-[#34568a] focus:outline-none focus:border-[#15B7AE]" />
      </div>
      <AutoTable data={filtered} loading={loading} error={error} exportFilename="deposits.csv" />
    </div>
  );
}
