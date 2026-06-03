"use client";
import { useState, useMemo } from "react";
import { useTableData } from "@/lib/hooks/useTableData";
import { DataTable, Column } from "@/components/ui/DataTable";
import { formatDate } from "@/lib/utils";
import { normalizeCall } from "@/lib/normalizers";
import { Search } from "lucide-react";

type CallRow = Record<string, unknown>;

export default function CallsPage() {
  const { data: raw, loading, error } = useTableData<CallRow>({ table: "outgoing_calls" });
  const data = useMemo(() => raw.map(normalizeCall), [raw]);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    return data.filter((r) => {
      if (search && !String(r.client_name ?? "").toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [data, search]);

  const columns: Column<CallRow>[] = [
    { key: "client_name", header: "Client" },
    { key: "date", header: "Date", render: (r) => formatDate(String(r.date ?? "")) },
    { key: "month", header: "Month" },
    { key: "outcome", header: "Outcome" },
    { key: "notes", header: "Notes" },
  ];

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
      <DataTable columns={columns} data={filtered} loading={loading} error={error}
        exportFilename="calls.csv" emptyMessage="No calls found" />
    </div>
  );
}
