"use client";
import { useState, useMemo } from "react";
import { useTableData } from "@/lib/hooks/useTableData";
import { DataTable, Column } from "@/components/ui/DataTable";
import { formatDate, formatCurrency, cn } from "@/lib/utils";
import { normalizeLtvPayment, normalizeLtvSummary } from "@/lib/normalizers";

type LtvRow = Record<string, unknown>;

export default function LtvPage() {
  const [activeTab, setActiveTab] = useState<"payments" | "summary">("payments");
  const { data: rawPayments, loading: loadingPayments } = useTableData<LtvRow>({ table: "ltv_sheet1" });
  const { data: rawSummary, loading: loadingSummary } = useTableData<LtvRow>({ table: "ltv_sheet2" });
  const payments = useMemo(() => rawPayments.map(normalizeLtvPayment), [rawPayments]);
  const summary = useMemo(() => rawSummary.map(normalizeLtvSummary), [rawSummary]);
  const [search, setSearch] = useState("");

  const filteredPayments = useMemo(() => {
    if (!search) return payments;
    return payments.filter((r) =>
      `${r.name ?? ""} ${r.email ?? ""}`.toLowerCase().includes(search.toLowerCase())
    );
  }, [payments, search]);

  const filteredSummary = useMemo(() => {
    if (!search) return summary;
    return summary.filter((r) =>
      String(r.name ?? "").toLowerCase().includes(search.toLowerCase())
    );
  }, [summary, search]);

  const paymentColumns: Column<LtvRow>[] = [
    { key: "date", header: "Date", render: (r) => formatDate(String(r.date ?? "")) },
    { key: "name", header: "Name" },
    { key: "email", header: "Email" },
    { key: "amount", header: "Amount", render: (r) => <span className="text-emerald-400 font-medium">{formatCurrency(String(r.amount ?? ""))}</span> },
    { key: "source", header: "Source" },
  ];

  const summaryColumns: Column<LtvRow>[] = [
    { key: "name", header: "Name" },
    { key: "ltv", header: "LTV", render: (r) => formatCurrency(String(r.ltv ?? "")) },
    { key: "average_ltv", header: "Avg LTV", render: (r) => formatCurrency(String(r.average_ltv ?? "")) },
    { key: "collected", header: "Collected", render: (r) => formatCurrency(String(r.collected ?? "")) },
    { key: "goal", header: "Goal", render: (r) => formatCurrency(String(r.goal ?? "")) },
    { key: "goal_pct", header: "Goal %", render: (r) => {
      const pct = parseFloat(String(r.goal_pct ?? ""));
      return <span className={cn("font-medium", isNaN(pct) ? "text-slate-400" : pct < 60 ? "text-red-400" : "text-emerald-400")}>
        {isNaN(pct) ? String(r.goal_pct ?? "—") : `${pct.toFixed(1)}%`}
      </span>;
    }},
    { key: "ad_spent", header: "Ad Spend", render: (r) => formatCurrency(String(r.ad_spent ?? "")) },
    { key: "roi", header: "ROI", render: (r) => {
      const roi = parseFloat(String(r.roi ?? ""));
      return <span className={cn("font-medium", !isNaN(roi) && roi > 0 ? "text-emerald-400" : "text-slate-400")}>
        {isNaN(roi) ? String(r.roi ?? "—") : `${roi.toFixed(1)}x`}
      </span>;
    }},
  ];

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-lg font-semibold text-white">LTV</h1>
      <div className="flex gap-1 border-b border-slate-700">
        {(["payments", "summary"] as const).map((tab) => (
          <button key={tab} onClick={() => { setActiveTab(tab); setSearch(""); }}
            className={cn("px-4 py-2.5 text-sm font-medium capitalize transition-colors border-b-2",
              activeTab === tab ? "text-teal-400 border-teal-500" : "text-slate-400 border-transparent hover:text-slate-200")}>
            {tab}
          </button>
        ))}
      </div>
      <input type="text"
        placeholder={`Search ${activeTab === "payments" ? "name or email" : "name"}…`}
        value={search} onChange={(e) => setSearch(e.target.value)}
        className="px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-teal-500 w-72" />
      {activeTab === "payments" ? (
        <DataTable columns={paymentColumns} data={filteredPayments} loading={loadingPayments}
          exportFilename="ltv-payments.csv" emptyMessage="No payment records found" />
      ) : (
        <DataTable columns={summaryColumns} data={filteredSummary} loading={loadingSummary}
          exportFilename="ltv-summary.csv" emptyMessage="No LTV summary found" />
      )}
    </div>
  );
}
