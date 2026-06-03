"use client";
import { useState, useMemo } from "react";
import { ChevronUp, ChevronDown, ChevronsUpDown, Download } from "lucide-react";
import { cn, exportToCsv } from "@/lib/utils";
import { TableSkeleton } from "./Skeleton";

export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => React.ReactNode;
  sortable?: boolean;
  className?: string;
}

interface DataTableProps<T extends Record<string, unknown>> {
  columns: Column<T>[];
  data: T[];
  loading?: boolean;
  error?: string | null;
  pageSize?: number;
  exportFilename?: string;
  emptyMessage?: string;
  rowClassName?: (row: T) => string;
  onRowClick?: (row: T) => void;
}

export function DataTable<T extends Record<string, unknown>>({
  columns,
  data,
  loading,
  error,
  pageSize = 50,
  exportFilename,
  emptyMessage = "No data found",
  rowClassName,
  onRowClick,
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);

  const sorted = useMemo(() => {
    if (!sortKey) return data;
    return [...data].sort((a, b) => {
      const av = String(a[sortKey] ?? "");
      const bv = String(b[sortKey] ?? "");
      return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
    });
  }, [data, sortKey, sortDir]);

  const totalPages = Math.ceil(sorted.length / pageSize);
  const pageData = sorted.slice((page - 1) * pageSize, page * pageSize);

  function handleSort(key: string) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
    setPage(1);
  }

  if (loading) {
    return <TableSkeleton rows={8} cols={columns.length} />;
  }

  if (error) {
    return (
      <div className="px-4 py-3 rounded-lg border border-red-700 bg-red-900/30 text-red-300 text-sm">
        <strong>Error loading data:</strong> {error}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {exportFilename && (
        <div className="flex justify-end">
          <button
            onClick={() => exportToCsv(exportFilename, data as Record<string, unknown>[])}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 rounded border border-slate-600 transition-colors"
          >
            <Download size={13} />
            Export CSV
          </button>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-slate-700">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-navy-800 border-b border-slate-700">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={cn(
                    "px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap",
                    col.sortable !== false && "cursor-pointer hover:text-teal-400 select-none",
                    col.className
                  )}
                  onClick={() => col.sortable !== false && handleSort(col.key)}
                >
                  <span className="flex items-center gap-1">
                    {col.header}
                    {col.sortable !== false && (
                      <span className="text-slate-600">
                        {sortKey === col.key ? (
                          sortDir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />
                        ) : (
                          <ChevronsUpDown size={12} />
                        )}
                      </span>
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageData.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-4 py-12 text-center text-slate-500"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              pageData.map((row, i) => (
                <tr
                  key={i}
                  onClick={() => onRowClick?.(row)}
                  className={cn(
                    "border-b border-slate-700/50 transition-colors",
                    onRowClick && "cursor-pointer",
                    i % 2 === 0 ? "bg-slate-800/30" : "bg-slate-800/10",
                    "hover:bg-slate-700/40",
                    rowClassName?.(row)
                  )}
                >
                  {columns.map((col) => (
                    <td key={col.key} className={cn("px-4 py-3 text-slate-200", col.className)}>
                      {col.render
                        ? col.render(row)
                        : (row[col.key] as string) ?? <span className="text-slate-500">—</span>}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-400">
            Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, sorted.length)} of{" "}
            {sorted.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(1)}
              disabled={page === 1}
              className="px-2 py-1 rounded bg-slate-700 disabled:opacity-40 hover:bg-slate-600 transition-colors"
            >
              «
            </button>
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-2 py-1 rounded bg-slate-700 disabled:opacity-40 hover:bg-slate-600 transition-colors"
            >
              ‹
            </button>
            <span className="px-3 py-1 rounded bg-teal-800/50 text-teal-300 border border-teal-700">
              {page} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="px-2 py-1 rounded bg-slate-700 disabled:opacity-40 hover:bg-slate-600 transition-colors"
            >
              ›
            </button>
            <button
              onClick={() => setPage(totalPages)}
              disabled={page === totalPages}
              className="px-2 py-1 rounded bg-slate-700 disabled:opacity-40 hover:bg-slate-600 transition-colors"
            >
              »
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
