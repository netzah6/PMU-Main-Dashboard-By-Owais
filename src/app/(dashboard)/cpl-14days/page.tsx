"use client";
import { useState, useMemo } from "react";
import { useTableData } from "@/lib/hooks/useTableData";
import { DataTable, Column } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { formatCurrency } from "@/lib/utils";
import { normalizeCpl } from "@/lib/normalizers";
import { Search } from "lucide-react";

type CplRow = Record<string, unknown>;

export default function Cpl14DaysPage() {
  const { data: raw, loading, error } = useTableData<CplRow>({ table: "cpl_14days" });
  const data = useMemo(
    () => raw.map(normalizeCpl),
    [raw]
  );
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!search) return data;
    return data.filter((r) =>
      `${r.campaign_name ?? ""} ${r.account_name ?? ""}`.toLowerCase().includes(search.toLowerCase())
    );
  }, [data, search]);

  const columns: Column<CplRow>[] = [
    { key: "campaign_name", header: "Campaign Name" },
    { key: "website_leads", header: "Website Leads" },
    { key: "cost_per_result", header: "CPL", render: (r) => <span className="text-teal-300 font-medium">{formatCurrency(String(r.cost_per_result ?? ""))}</span> },
    { key: "account_name", header: "Account Name" },
    { key: "account_status", header: "Account Status", render: (r) => {
      const s = String(r.account_status ?? "");
      return <Badge variant={s.toUpperCase() === "ACTIVE" ? "green" : s.toUpperCase() === "UNSETTLED" ? "red" : "gray"}>{s || "—"}</Badge>;
    }},
    { key: "daily_budget", header: "Daily Budget", render: (r) => formatCurrency(String(r.daily_budget ?? "")) },
    { key: "amount_spent", header: "Amount Spent", render: (r) => formatCurrency(String(r.amount_spent ?? "")) },
  ];

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-white">CPL — 14 Days</h1>
        <span className="text-xs text-slate-400">{filtered.length} campaigns</span>
      </div>
      <div className="relative w-72">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input type="text" placeholder="Search campaign or account…" value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-8 pr-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-teal-500" />
      </div>
      <DataTable columns={columns} data={filtered} loading={loading} error={error}
        exportFilename="cpl-14days.csv" emptyMessage="No CPL data found" />
    </div>
  );
}
