"use client";
import { useState, useMemo } from "react";
import { useTableData } from "@/lib/hooks/useTableData";
import { DataTable, Column } from "@/components/ui/DataTable";
import { formatCurrency } from "@/lib/utils";
import { normalizeCampaignBudget } from "@/lib/normalizers";
import { Search } from "lucide-react";

type BudgetRow = Record<string, unknown>;

export default function BudgetPage() {
  const { data: raw, loading, error } = useTableData<BudgetRow>({ table: "campaign_spent" });
  const data = useMemo(
    () => raw.map(normalizeCampaignBudget),
    [raw]
  );
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!search) return data;
    return data.filter((r) =>
      String(r.campaign_name ?? "").toLowerCase().includes(search.toLowerCase())
    );
  }, [data, search]);

  const totalSpent = filtered.reduce((sum, r) => {
    const v = parseFloat(String(r.spent ?? "").replace(/[$,]/g, ""));
    return sum + (isNaN(v) ? 0 : v);
  }, 0);

  const columns: Column<BudgetRow>[] = [
    { key: "campaign_name", header: "Campaign Name" },
    { key: "budget", header: "Budget", render: (r) => formatCurrency(String(r.budget ?? "")) },
    { key: "spent", header: "Spent", render: (r) => <span className="text-amber-300">{formatCurrency(String(r.spent ?? ""))}</span> },
    { key: "remaining", header: "Remaining", render: (r) => {
      const budget = parseFloat(String(r.budget ?? "").replace(/[$,]/g, ""));
      const spent = parseFloat(String(r.spent ?? "").replace(/[$,]/g, ""));
      if (!isNaN(budget) && !isNaN(spent)) {
        const rem = budget - spent;
        return <span className={rem >= 0 ? "text-emerald-400" : "text-red-400"}>{formatCurrency(rem)}</span>;
      }
      return formatCurrency(String(r.remaining ?? ""));
    }},
    { key: "account_name", header: "Account" },
    { key: "date", header: "Date" },
  ];

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-white">Campaign Budget — All Time</h1>
        <div className="bg-slate-800 rounded-lg px-4 py-2 border border-slate-700">
          <span className="text-slate-400 text-xs">Total Spent</span>
          <p className="text-amber-400 font-semibold">{formatCurrency(totalSpent)}</p>
        </div>
      </div>
      <div className="relative w-72">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input type="text" placeholder="Search campaign…" value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-8 pr-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-teal-500" />
      </div>
      <DataTable columns={columns} data={filtered} loading={loading} error={error}
        exportFilename="campaign-budget.csv" emptyMessage="No budget data found" />
    </div>
  );
}
