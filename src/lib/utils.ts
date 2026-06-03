import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Parse a date string from Google Sheets (DD/MM/YYYY, MM/DD/YYYY, ISO, etc.)
 * and return a human-readable string.
 */
export function formatDate(dateStr: string | undefined | null): string {
  if (!dateStr || dateStr === "") return "—";
  const s = String(dateStr).trim();

  // DD/MM/YYYY  or  D/M/YYYY
  const dmY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (dmY) {
    const d = parseInt(dmY[1], 10);
    const m = parseInt(dmY[2], 10);
    const y = parseInt(dmY[3], 10);
    // If day > 12 it must be DD/MM; otherwise assume DD/MM (Sheets default)
    const date = new Date(y, m - 1, d);
    if (!isNaN(date.getTime())) {
      return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }
  }

  // ISO or any JS-parseable format
  try {
    const date = new Date(s);
    if (!isNaN(date.getTime())) {
      return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }
  } catch { /* fall through */ }

  return s;
}

export function formatCurrency(val: string | number | undefined | null): string {
  if (val == null || val === "") return "—";
  const num = typeof val === "number" ? val : parseFloat(String(val).replace(/[$,]/g, ""));
  if (isNaN(num)) return String(val);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(num);
}

export function formatPercent(val: string | number | undefined | null): string {
  if (val == null || val === "") return "—";
  const num = typeof val === "number" ? val : parseFloat(String(val).replace(/%/g, ""));
  if (isNaN(num)) return String(val);
  // If already expressed as a fraction (< 1), multiply by 100
  const pct = num < 1 && num > -1 && String(val).indexOf("%") === -1 ? num * 100 : num;
  return `${pct.toFixed(1)}%`;
}

export function exportToCsv(filename: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const csv = [
    headers.join(","),
    ...rows.map((r) =>
      headers.map((h) => `"${String(r[h] ?? "").replace(/"/g, '""')}"`).join(",")
    ),
  ].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
