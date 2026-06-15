"use client";
import { useState, useMemo } from "react";
import { useTableData } from "@/lib/hooks/useTableData";
import { AutoTable } from "@/components/ui/AutoTable";
import { sortNewestFirst } from "@/lib/utils";
import { Search } from "lucide-react";

type DateRange = "7" | "14" | "30" | "all";

export default function LeadsPage() {
  const { data, loading, error } = useTableData<Record<string, unknown>>({ table: "leads_master" });
  const [search, setSearch] = useState("");
  const [dateRange, setDateRange] = useState<DateRange>("all");

  const filtered = useMemo(() => {
    const now = new Date();
    return sortNewestFirst(data.filter((r) => {
      const text = `${r["Full Name"] ?? ""} ${r["Email"] ?? ""} ${r["Business Name"] ?? ""}`.toLowerCase();
      if (search && !text.includes(search.toLowerCase())) return false;
      if (dateRange !== "all") {
        const d = new Date(String(r["Date"] ?? r.date ?? ""));
        const diff = (now.getTime() - d.getTime()) / 86400000;
        if (isNaN(diff) || diff > parseInt(dateRange)) return false;
      }
      return true;
    }));
  }, [data, search, dateRange]);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-[#1f3559]">Leads</h1>
        <span className="text-xs text-[#697a91]">{filtered.length} records</span>
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#697a91]" />
          <input type="text" placeholder="Search name, email, business…" value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 pr-3 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm text-[#1f3559] placeholder:text-[#8595a8] focus:outline-none focus:border-[#15B7AE] w-64" />
        </div>
        <select value={dateRange} onChange={(e) => setDateRange(e.target.value as DateRange)}
          className="px-3 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm text-[#34568a] focus:outline-none focus:border-[#15B7AE]">
          <option value="all">All Time</option>
          <option value="7">Last 7 Days</option>
          <option value="14">Last 14 Days</option>
          <option value="30">Last 30 Days</option>
        </select>
      </div>
      <AutoTable data={filtered} loading={loading} error={error} exportFilename="leads.csv" />
    </div>
  );
}
