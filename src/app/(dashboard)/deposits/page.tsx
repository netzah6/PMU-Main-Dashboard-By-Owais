"use client";
import { useState, useMemo } from "react";
import { useTableData } from "@/lib/hooks/useTableData";
import { DataTable, Column } from "@/components/ui/DataTable";
import { Badge, statusVariant } from "@/components/ui/Badge";
import { formatDate, formatCurrency } from "@/lib/utils";
import { normalizeDeposit } from "@/lib/normalizers";
import { Search } from "lucide-react";

type DepositRow = Record<string, unknown>;

export default function DepositsPage() {
  const { data: raw, loading, error } = useTableData<DepositRow>({ table: "deposits" });
  const data = useMemo(() => raw.map(normalizeDeposit), [raw]);
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");

  const filtered = useMemo(() => {
    return data.filter((r) => {
      if (search && !String(r.client_name ?? "").toLowerCase().includes(search.toLowerCase())) return false;
      if (dateFrom && String(r.date ?? "") < dateFrom) return false;
      if (dateTo && String(r.date ?? "") > dateTo) return false;
      if (statusFilter !== "All" && String(r.status ?? "") !== statusFilter) return false;
      return true;
    });
  }, [data, search, dateFrom, dateTo, statusFilter]);

  const totalAmount = filtered.reduce((sum, r) => {
    const amt = parseFloat(String(r.amount ?? "").replace(/[$,]/g, ""));
    return sum + (isNaN(amt) ? 0 : amt);
  }, 0);

  const thisMonthAmount = filtered.filter((r) => {
    const d = new Date(String(r.date ?? ""));
    const now = new Date();
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }).reduce((sum, r) => {
    const amt = parseFloat(String(r.amount ?? "").replace(/[$,]/g, ""));
    return sum + (isNaN(amt) ? 0 : amt);
  }, 0);

  const columns: Column<DepositRow>[] = [
    { key: "client_name", header: "Client" },
    { key: "date", header: "Date", render: (r) => formatDate(String(r.date ?? "")) },
    { key: "amount", header: "Amount", render: (r) => <span className="text-emerald-400 font-medium">{formatCurrency(String(r.amount ?? ""))}</span> },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(String(r.status ?? ""))}>{String(r.status ?? "—")}</Badge> },
    { key: "notes", header: "Notes" },
  ];

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-white">Deposits</h1>
        <div className="flex gap-4 text-sm">
          <div className="bg-slate-800 rounded-lg px-4 py-2 border border-slate-700">
            <span className="text-slate-400 text-xs">Total</span>
            <p className="text-emerald-400 font-semibold">{formatCurrency(totalAmount)}</p>
          </div>
          <div className="bg-slate-800 rounded-lg px-4 py-2 border border-slate-700">
            <span className="text-slate-400 text-xs">This Month</span>
            <p className="text-emerald-400 font-semibold">{formatCurrency(thisMonthAmount)}</p>
          </div>
        </div>
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
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-300 focus:outline-none focus:border-teal-500">
          <option value="All">All Status</option>
          <option value="Paid">Paid</option>
          <option value="Pending">Pending</option>
          <option value="Failed">Failed</option>
        </select>
      </div>
      <DataTable columns={columns} data={filtered} loading={loading} error={error}
        exportFilename="deposits.csv" emptyMessage="No deposits found" />
    </div>
  );
}
