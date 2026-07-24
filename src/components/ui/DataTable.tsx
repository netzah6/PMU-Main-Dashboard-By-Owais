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
  const [size, setSize] = useState(pageSize);

  const sorted = useMemo(() => {
    if (!sortKey) return data;
    return [...data].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const as = String(av ?? "").trim();
      const bs = String(bv ?? "").trim();
      // Numeric sort when both values are numbers (ignoring $, commas, %)
      const an = parseFloat(as.replace(/[$,%\s]/g, ""));
      const bn = parseFloat(bs.replace(/[$,%\s]/g, ""));
      const bothNumeric = as !== "" && bs !== "" && !isNaN(an) && !isNaN(bn);
      let cmp: number;
      if (bothNumeric) cmp = an - bn;
      else if (as === "" && bs !== "") cmp = 1;   // empties last
      else if (as !== "" && bs === "") cmp = -1;
      else cmp = as.localeCompare(bs);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [data, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / size));
  const safePage = Math.min(page, totalPages);
  const pageData = sorted.slice((safePage - 1) * size, safePage * size);

  function handleSort(key: string) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
    setPage(1);
  }

  // Shared cell renderer so the mobile cards show exactly the same data as the table.
  function cellValue(col: Column<T>, row: T): React.ReactNode {
    if (col.render) return col.render(row);
    const v = row[col.key];
    if (v === null || v === undefined || String(v).trim() === "") {
      return <span className="text-[#8595a8]">—</span>;
    }
    return String(v);
  }

  if (loading) {
    return <TableSkeleton rows={8} cols={columns.length} />;
  }

  if (error) {
    return (
      <div className="px-4 py-3 rounded-lg border border-[#f5c2cf] bg-[#fde8ee] text-[#e11d48] text-sm">
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
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[#e4ebf2] hover:bg-[#dbe5ef] rounded border border-[#d7e0ea] transition-colors"
          >
            <Download size={13} />
            Export CSV
          </button>
        </div>
      )}

      {/* Mobile: sort control (table headers aren't visible on cards) */}
      {columns.some((c) => c.sortable !== false) && (
        <div className="md:hidden flex items-center gap-2">
          <select
            value={sortKey ?? ""}
            onChange={(e) => { setSortKey(e.target.value || null); setPage(1); }}
            className="flex-1 px-2 py-1.5 bg-white border border-[#e4ebf2] rounded-lg text-xs text-[#34568a] focus:outline-none focus:border-[#15B7AE]"
          >
            <option value="">Sort by…</option>
            {columns.filter((c) => c.sortable !== false).map((c) => (
              <option key={c.key} value={c.key}>{c.header}</option>
            ))}
          </select>
          {sortKey && (
            <button
              onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#e4ebf2] text-[#34568a] border border-[#d7e0ea]"
            >
              {sortDir === "asc" ? "↑ Asc" : "↓ Desc"}
            </button>
          )}
        </div>
      )}

      {/* Mobile: card list — same columns/data as the desktop table, stacked */}
      <div className="md:hidden space-y-2">
        {pageData.length === 0 ? (
          <div className="px-4 py-12 text-center text-[#8595a8] rounded-[14px] border border-[#e4ebf2] bg-white">
            {emptyMessage}
          </div>
        ) : (
          pageData.map((row, i) => (
            <div
              key={i}
              onClick={() => onRowClick?.(row)}
              className={cn(
                "rounded-xl border border-[#e4ebf2] bg-white p-3",
                onRowClick && "cursor-pointer active:bg-[#e6faf8]",
                rowClassName?.(row)
              )}
              style={{ boxShadow: "var(--shadow-sm)" }}
            >
              <div className="text-sm font-semibold text-[#1f3559] break-words">
                {cellValue(columns[0], row)}
              </div>
              {columns.length > 1 && (
                <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1">
                  {columns.slice(1).map((col) => {
                    // Mobile cards: skip empty fields entirely — a wall of "—"
                    // rows just forces scrolling without saying anything.
                    const raw = row[col.key];
                    if (raw === null || raw === undefined || String(raw).trim() === "") return null;
                    return (
                      <div key={col.key} className="min-w-0">
                        <dt className="text-[10px] uppercase tracking-wide text-[#8595a8]">{col.header}</dt>
                        <dd className="text-sm text-[#1e2a3a] break-words">{cellValue(col, row)}</dd>
                      </div>
                    );
                  })}
                </dl>
              )}
            </div>
          ))
        )}
      </div>

      <div className="hidden md:block overflow-x-auto rounded-[14px] border border-[#e4ebf2] bg-white" style={{ boxShadow: "var(--shadow-sm)" }}>
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: "linear-gradient(180deg, #34568a, #26416b)" }}>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={cn(
                    "px-3 py-1.5 text-left text-[10.5px] font-bold text-white uppercase tracking-wider whitespace-nowrap sticky top-0",
                    col.sortable !== false && "cursor-pointer select-none",
                    col.className
                  )}
                  onClick={() => col.sortable !== false && handleSort(col.key)}
                >
                  <span className="flex items-center gap-1">
                    {col.header}
                    {col.sortable !== false && (
                      <span className="text-white/60">
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
                  className="px-4 py-12 text-center text-[#8595a8]"
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
                    "border-b border-[#eef3f8] transition-colors",
                    onRowClick && "cursor-pointer",
                    i % 2 === 0 ? "bg-white" : "bg-[#fafcfe]",
                    "hover:bg-[#e6faf8]",
                    rowClassName?.(row)
                  )}
                >
                  {columns.map((col) => (
                    <td key={col.key} className={cn("px-3 py-1.5 text-[#1e2a3a]", col.className)}>
                      {col.render
                        ? col.render(row)
                        : (row[col.key] as string) ?? <span className="text-[#8595a8]">—</span>}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {sorted.length > 0 && (
        <div className="flex items-center justify-between text-sm gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <span className="text-[#697a91]">
              Showing {(safePage - 1) * size + 1}–{Math.min(safePage * size, sorted.length)} of {sorted.length}
            </span>
            <label className="flex items-center gap-1.5 text-[#697a91]">
              Rows:
              <select
                value={size}
                onChange={(e) => { setSize(Number(e.target.value)); setPage(1); }}
                className="px-2 py-1 bg-white border border-[#e4ebf2] rounded text-[#34568a] focus:outline-none focus:border-[#15B7AE]"
              >
                {[50, 100, 200, 500].map((n) => <option key={n} value={n}>{n}</option>)}
                <option value={999999}>All</option>
              </select>
            </label>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center gap-1">
              <button onClick={() => setPage(1)} disabled={safePage === 1}
                className="px-2 py-1 rounded bg-[#e4ebf2] disabled:opacity-40 hover:bg-[#dbe5ef] transition-colors">«</button>
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage === 1}
                className="px-2 py-1 rounded bg-[#e4ebf2] disabled:opacity-40 hover:bg-[#dbe5ef] transition-colors">‹</button>
              <span className="px-3 py-1 rounded bg-[#e6f7f5] text-[#0e8f88] border border-[#a7e3df]">{safePage} / {totalPages}</span>
              <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={safePage === totalPages}
                className="px-2 py-1 rounded bg-[#e4ebf2] disabled:opacity-40 hover:bg-[#dbe5ef] transition-colors">›</button>
              <button onClick={() => setPage(totalPages)} disabled={safePage === totalPages}
                className="px-2 py-1 rounded bg-[#e4ebf2] disabled:opacity-40 hover:bg-[#dbe5ef] transition-colors">»</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
