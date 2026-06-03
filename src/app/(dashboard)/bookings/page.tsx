"use client";
import { useState, useMemo } from "react";
import { useTableData } from "@/lib/hooks/useTableData";
import { DataTable, Column } from "@/components/ui/DataTable";
import { formatDate } from "@/lib/utils";
import { normalizeBooking } from "@/lib/normalizers";
import { Search } from "lucide-react";

type BookingRow = Record<string, unknown>;

export default function BookingsPage() {
  const { data: raw, loading, error } = useTableData<BookingRow>({ table: "bookings" });
  const data = useMemo(() => raw.map(normalizeBooking), [raw]);
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const filtered = useMemo(() => {
    return data.filter((r) => {
      const text = `${r.client_name ?? ""} ${r.name ?? ""}`.toLowerCase();
      if (search && !text.includes(search.toLowerCase())) return false;
      if (dateFrom && String(r.date ?? "") < dateFrom) return false;
      if (dateTo && String(r.date ?? "") > dateTo) return false;
      return true;
    });
  }, [data, search, dateFrom, dateTo]);

  const columns: Column<BookingRow>[] = [
    { key: "client_name", header: "Business" },
    { key: "name", header: "Lead Name" },
    { key: "date", header: "Date", render: (r) => formatDate(String(r.date ?? "")) },
    { key: "email", header: "Email" },
    { key: "phone", header: "Phone" },
    { key: "status", header: "Status" },
  ];

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-white">Bookings</h1>
        <span className="text-xs text-slate-400">{filtered.length} records</span>
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input type="text" placeholder="Search business or name…" value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 pr-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-teal-500" />
        </div>
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
          className="px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-300 focus:outline-none focus:border-teal-500" />
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
          className="px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-300 focus:outline-none focus:border-teal-500" />
      </div>
      <DataTable columns={columns} data={filtered} loading={loading} error={error}
        exportFilename="bookings.csv" emptyMessage="No bookings found" />
    </div>
  );
}
