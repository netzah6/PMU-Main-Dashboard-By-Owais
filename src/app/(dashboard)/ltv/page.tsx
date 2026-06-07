"use client";
import { useState } from "react";
import { useTableData } from "@/lib/hooks/useTableData";
import { AutoTable } from "@/components/ui/AutoTable";
import { cn } from "@/lib/utils";

export default function LtvPage() {
  const [activeTab, setActiveTab] = useState<"payments" | "summary">("payments");
  const { data: payments, loading: lp, error: ep } = useTableData<Record<string, unknown>>({ table: "ltv_sheet1" });
  const { data: summary, loading: ls, error: es } = useTableData<Record<string, unknown>>({ table: "ltv_sheet2" });
  const [search, setSearch] = useState("");

  const filter = (rows: Record<string, unknown>[]) => {
    if (!search) return rows;
    const q = search.toLowerCase();
    return rows.filter((r) => Object.values(r).some((v) => String(v ?? "").toLowerCase().includes(q)));
  };

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-lg font-semibold text-[#1f3559]">LTV</h1>
      <div className="flex gap-1 border-b border-[#e4ebf2]">
        {(["payments", "summary"] as const).map((tab) => (
          <button key={tab} onClick={() => { setActiveTab(tab); setSearch(""); }}
            className={cn("px-4 py-2.5 text-sm font-medium capitalize transition-colors border-b-2",
              activeTab === tab ? "text-[#0e8f88] border-[#15B7AE]" : "text-[#697a91] border-transparent hover:text-[#1e2a3a]")}>
            {tab}
          </button>
        ))}
      </div>
      <input type="text" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)}
        className="px-3 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm text-[#1f3559] placeholder:text-[#8595a8] focus:outline-none focus:border-[#15B7AE] w-72" />
      {activeTab === "payments"
        ? <AutoTable data={filter(payments)} loading={lp} error={ep} exportFilename="ltv-payments.csv" />
        : <AutoTable data={filter(summary)} loading={ls} error={es} exportFilename="ltv-summary.csv" />
      }
    </div>
  );
}
