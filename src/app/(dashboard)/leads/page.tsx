"use client";
import { useState, useMemo } from "react";
import { useTableData } from "@/lib/hooks/useTableData";
import { DataTable, Column } from "@/components/ui/DataTable";
import { formatDate } from "@/lib/utils";
import { normalizeLead } from "@/lib/normalizers";
import { Search } from "lucide-react";

type LeadRow = Record<string, unknown>;
type DateRange = "7" | "14" | "30" | "all";

export default function LeadsPage() {
  const { data: raw, loading, error } = useTableData<LeadRow>({ table: "leads_master" });
  const data = useMemo(() => raw.map(normalizeLead), [raw]);
  const [search, setSearch] = useState("");
  const [dateRange, setDateRange] = useState<DateRange>("all");

  const filtered = useMemo(() => {
    const now = new Date();
    return data.filter((r) => {
      const text = `${r.name ?? ""} ${r.email ?? ""} ${r.business ?? ""}`.toLowerCase();
      if (search && !text.includes(search.toLowerCase())) return false;
      if (dateRange !== "all") {
        const days = parseInt(dateRange);
        const d = new Date(String(r.date ?? ""));
        const diff = (now.getTime() - d.getTime()) / 86400000;
        if (isNaN(diff) || diff > days) return false;
      }
      return true;
    });
  }, [data, search, dateRange]);

  const columns: Column<LeadRow>[] = [
    { key: "name", header: "Name" },
    { key: "email", header: "Email" },
    { key: "phone", header: "Phone" },
    { key: "business", header: "Business" },
    { key: "date", header: "Date", render: (r) => formatDate(String(r.date ?? "")) },
    { key: "source", header: "Source" },
    { key: "status", header: "Status" },
  ];

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-white">Leads</h1>
        <span className="text-xs text-slate-400">{filtered.length} records</span>
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input type="text" placeholder="Search name, email, business…" value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 pr-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-teal-500 w-64" />
        </div>
        <select value={dateRange} onChange={(e) => setDateRange(e.target.value as DateRange)}
          className="px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-300 focus:outline-none focus:border-teal-500">
          <option value="all">All Time</option>
          <option value="7">Last 7 Days</option>
          <option value="14">Last 14 Days</option>
          <option value="30">Last 30 Days</option>
        </select>
      </div>
      <DataTable columns={columns} data={filtered} loading={loading} error={error}
        exportFilename="leads.csv" emptyMessage="No leads found" />
    </div>
  );
}
