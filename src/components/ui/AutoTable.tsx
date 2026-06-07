"use client";
/**
 * AutoTable — renders a DataTable whose columns are derived from the data itself.
 * Used for tabs where we don't know the exact column names in advance.
 * Skips internal meta keys (_supabase_id, _row_number, row_number).
 */
import { useMemo } from "react";
import { DataTable, Column } from "./DataTable";
import { formatDate, formatCurrency } from "@/lib/utils";

const SKIP_KEYS = new Set(["_supabase_id", "_row_number", "row_number"]);

const DATE_HINTS = ["date", "signed", "call", "created", "updated", "last"];
const CURRENCY_HINTS = ["amount", "price", "budget", "spent", "ltv", "cpl", "cost", "roi", "collected", "goal"];

function isDateKey(k: string) { return DATE_HINTS.some((h) => k.toLowerCase().includes(h)); }
function isCurrencyKey(k: string) { return CURRENCY_HINTS.some((h) => k.toLowerCase().includes(h)); }

interface AutoTableProps {
  data: Record<string, unknown>[];
  loading?: boolean;
  error?: string | null;
  exportFilename?: string;
  maxCols?: number;
}

export function AutoTable({ data, loading, error, exportFilename, maxCols = 12 }: AutoTableProps) {
  const columns = useMemo<Column<Record<string, unknown>>[]>(() => {
    if (!data.length) return [];

    // Collect all keys from the first ~5 rows (some rows may have more keys)
    const keySet = new Set<string>();
    data.slice(0, 5).forEach((r) => Object.keys(r).forEach((k) => keySet.add(k)));

    return Array.from(keySet)
      .filter((k) => !SKIP_KEYS.has(k))
      .slice(0, maxCols)
      .map((key) => ({
        key,
        header: key
          .replace(/_/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase()),
        render: (r: Record<string, unknown>) => {
          const val = r[key];
          if (val === null || val === undefined || val === "") return <span className="text-[#a6b3c4]">—</span>;
          const s = String(val);
          if (isDateKey(key) && !isCurrencyKey(key)) {
            const fmt = formatDate(s);
            return fmt !== "—" ? fmt : s;
          }
          if (isCurrencyKey(key) && !isNaN(parseFloat(s.replace(/[$,]/g, "")))) {
            return formatCurrency(s);
          }
          if (typeof val === "boolean") {
            return (
              <span className={val ? "text-[#0e8f88] font-medium" : "text-[#8595a8]"}>
                {val ? "✓" : "✗"}
              </span>
            );
          }
          return s;
        },
      }));
  }, [data, maxCols]);

  return (
    <DataTable
      columns={columns}
      data={data}
      loading={loading}
      error={error}
      exportFilename={exportFilename}
      emptyMessage="No data — run a sync from the Sync page"
    />
  );
}
