"use client";
import { useState, useMemo } from "react";
import { useTableData } from "@/lib/hooks/useTableData";
import { DataTable, Column } from "@/components/ui/DataTable";
import { formatDate, formatPercent } from "@/lib/utils";
import { normalizePerformance } from "@/lib/normalizers";
import { Search } from "lucide-react";

type PerfRow = Record<string, unknown>;

export default function PerformancePage() {
  const { data: raw, loading, error } = useTableData<PerfRow>({ table: "performance_tracking" });
  const data = useMemo(
    () => raw.map(normalizePerformance),
    [raw]
  );
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const filtered = useMemo(() => {
    return data.filter((r) => {
      if (search && !String(r.client_name ?? "").toLowerCase().includes(search.toLowerCase())) return false;
      if (dateFrom && String(r.date ?? "") < dateFrom) return false;
      if (dateTo && String(r.date ?? "") > dateTo) return false;
      return true;
    });
  }, [data, search, dateFrom, dateTo]);

  const columns: Column<PerfRow>[] = [
    { key: "client_name", header: "Client Name" },
    { key: "date", header: "Date", render: (r) => formatDate(String(r.date ?? "")) },
    { key: "happy", header: "Happy" },
    { key: "last_strategy_call", header: "Last Strategy Call", render: (r) => formatDate(String(r.last_strategy_call ?? "")) },
    { key: "deposits", header: "Deposits" },
    { key: "sessions_done", header: "Sessions Done" },
    { key: "call_chat", header: "Call/Chat" },
    { key: "leads", header: "Leads" },
    { key: "bookings", header: "Bookings" },
    { key: "booking_pct", header: "Booking %", render: (r) => formatPercent(r.booking_pct as string) },
    { key: "dashboard_organized", header: "Dashboard" },
  ];

  function rowClassName(r: PerfRow): string {
    const pct = parseFloat(String(r.booking_pct ?? ""));
    if (!isNaN(pct)) {
      if (pct >= 30) return "bg-emerald-900/10";
      if (pct < 15) return "bg-red-900/10";
    }
    return "";
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-white">Performance Tracking</h1>
        <span className="text-xs text-slate-400">{filtered.length} records</span>
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input type="text" placeholder="Search client…" value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 pr-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-teal-500" />
        </div>
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
          className="px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-300 focus:outline-none focus:border-teal-500" />
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
          className="px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-300 focus:outline-none focus:border-teal-500" />
      </div>
      <DataTable columns={columns} data={filtered} loading={loading} error={error}
        exportFilename="performance.csv" emptyMessage="No performance records found"
        rowClassName={rowClassName} />
    </div>
  );
}
