"use client";
import { useState, useMemo } from "react";
import { useTableData } from "@/lib/hooks/useTableData";
import { AutoTable } from "@/components/ui/AutoTable";
import { Search } from "lucide-react";

export default function CallsPage() {
  const { data, loading, error } = useTableData<Record<string, unknown>>({ table: "outgoing_calls" });
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!search) return data;
    return data.filter((r) =>
      `${r["Business Name"] ?? ""} ${r["Full Name"] ?? ""}`.toLowerCase().includes(search.toLowerCase())
    );
  }, [data, search]);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-white">Outgoing Calls</h1>
        <span className="text-xs text-slate-400">{filtered.length} records</span>
      </div>
      <div className="relative w-64">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input type="text" placeholder="Search client…" value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-8 pr-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-teal-500" />
      </div>
      <AutoTable data={filtered} loading={loading} error={error} exportFilename="calls.csv" />
    </div>
  );
}
