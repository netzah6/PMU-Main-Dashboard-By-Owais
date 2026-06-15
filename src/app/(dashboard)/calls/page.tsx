"use client";
import { useState, useMemo } from "react";
import { useTableData } from "@/lib/hooks/useTableData";
import { AutoTable } from "@/components/ui/AutoTable";
import { sortNewestFirst } from "@/lib/utils";
import { Search } from "lucide-react";

export default function CallsPage() {
  const { data, loading, error } = useTableData<Record<string, unknown>>({ table: "outgoing_calls" });
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const rows = search
      ? data.filter((r) =>
          `${r["Business Name"] ?? ""} ${r["Full Name"] ?? ""}`.toLowerCase().includes(search.toLowerCase())
        )
      : data;
    return sortNewestFirst(rows);
  }, [data, search]);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-[#1f3559]">Outgoing Calls</h1>
        <span className="text-xs text-[#697a91]">{filtered.length} records</span>
      </div>
      <div className="relative w-64">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#697a91]" />
        <input type="text" placeholder="Search client…" value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-8 pr-3 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm text-[#1f3559] placeholder:text-[#8595a8] focus:outline-none focus:border-[#15B7AE]" />
      </div>
      <AutoTable data={filtered} loading={loading} error={error} exportFilename="calls.csv" />
    </div>
  );
}
