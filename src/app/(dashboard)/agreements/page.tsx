"use client";
import { useState, useMemo } from "react";
import { useTableData } from "@/lib/hooks/useTableData";
import { DataTable, Column } from "@/components/ui/DataTable";
import { formatDate } from "@/lib/utils";
import { normalizeAgreement } from "@/lib/normalizers";
import { Search } from "lucide-react";

type AgreementRow = Record<string, unknown>;

export default function AgreementsPage() {
  const { data: raw, loading, error } = useTableData<AgreementRow>({ table: "signed_agreements" });
  const data = useMemo(() => raw.map(normalizeAgreement), [raw]);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    return data.filter((r) => {
      if (search) {
        const text = `${r.name ?? ""} ${r.email ?? ""}`.toLowerCase();
        if (!text.includes(search.toLowerCase())) return false;
      }
      return true;
    });
  }, [data, search]);

  const columns: Column<AgreementRow>[] = [
    { key: "name", header: "Name" },
    { key: "email", header: "Email" },
    { key: "date", header: "Date Signed", render: (r) => formatDate(String(r.date ?? "")) },
    { key: "type", header: "Type" },
    { key: "status", header: "Status" },
    { key: "notes", header: "Notes" },
  ];

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-white">Signed Agreements</h1>
        <span className="text-xs text-slate-400">{filtered.length} records</span>
      </div>
      <div className="relative w-64">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input type="text" placeholder="Search name, email…" value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-8 pr-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-teal-500" />
      </div>
      <DataTable columns={columns} data={filtered} loading={loading} error={error}
        exportFilename="agreements.csv" emptyMessage="No agreements found" />
    </div>
  );
}
