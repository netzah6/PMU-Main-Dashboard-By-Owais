"use client";
import { useState, useMemo } from "react";
import { useTableData } from "@/lib/hooks/useTableData";
import { DataTable, Column } from "@/components/ui/DataTable";
import { formatDate, sortNewestFirst } from "@/lib/utils";
import { Search } from "lucide-react";

export default function AgreementsPage() {
  const { data, loading, error } = useTableData<Record<string, unknown>>({ table: "signed_agreements" });
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const rows = search
      ? data.filter((r) =>
          `${r["Full Name"] ?? ""} ${r["Email"] ?? ""}`.toLowerCase().includes(search.toLowerCase())
        )
      : data;
    return sortNewestFirst(rows);
  }, [data, search]);

  const columns = useMemo<Column<Record<string, unknown>>[]>(
    () => [
      {
        key: "Signed Date",
        header: "Sign Date",
        render: (r) => {
          const raw = String(r["Signed Date"] ?? r["Date"] ?? r.date ?? "");
          return raw ? formatDate(raw) : <span className="text-[#a6b3c4]">—</span>;
        },
      },
      {
        key: "Full Name",
        header: "Full Name",
        render: (r) => {
          const name = String(r["Full Name"] ?? r.name ?? "");
          return name ? (
            <span className="font-medium text-[#1f3559]">{name}</span>
          ) : (
            <span className="text-[#a6b3c4]">—</span>
          );
        },
      },
    ],
    []
  );

  return (
    <div className="p-3 md:p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-[#1f3559]">Signed Agreements</h1>
        <span className="text-xs text-[#697a91]">{filtered.length} records</span>
      </div>
      <div className="relative w-64">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#697a91]" />
        <input type="text" placeholder="Search name, email…" value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-8 pr-3 py-2 bg-white border border-[#e4ebf2] rounded-lg text-sm text-[#1f3559] placeholder:text-[#8595a8] focus:outline-none focus:border-[#15B7AE]" />
      </div>
      <DataTable
        columns={columns}
        data={filtered}
        loading={loading}
        error={error}
        exportFilename="agreements.csv"
        emptyMessage="No agreements — run a sync from the Sync page"
      />
    </div>
  );
}
