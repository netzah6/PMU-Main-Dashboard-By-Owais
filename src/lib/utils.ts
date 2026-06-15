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

// A curated palette of visually DISTINCT colors (no two similar hues, so e.g.
// two greens never appear). Each entry: strong text on a light bg.
type ColorTrio = { text: string; bg: string; border: string };
const USER_PALETTE: ColorTrio[] = [
  { text: "#1d4ed8", bg: "#e7edff", border: "#c2d2ff" }, // blue
  { text: "#c2410c", bg: "#fff0e6", border: "#ffd5b8" }, // orange
  { text: "#be185d", bg: "#ffe9f2", border: "#fbc6dc" }, // pink
  { text: "#6d28d9", bg: "#f1e9ff", border: "#ddc9fb" }, // purple
  { text: "#0f766e", bg: "#e0f5f2", border: "#b3e3dd" }, // teal
  { text: "#b91c1c", bg: "#fde7e7", border: "#f7c2c2" }, // red
  { text: "#a16207", bg: "#fdf4d8", border: "#f1dfa0" }, // amber
  { text: "#4338ca", bg: "#e9e9ff", border: "#cccbf7" }, // indigo
  { text: "#0e7490", bg: "#e0f4fa", border: "#b3e2ef" }, // cyan
  { text: "#15803d", bg: "#e6f6ea", border: "#bce6c8" }, // green
];

// Pinned team colors (match the owner's sheet color scheme).
const KNOWN_USERS: Record<string, number> = {
  stephanie: 0, // blue
  nicolas: 6,   // yellow/amber
  francisco: 9, // green
  marie: 3,     // purple
  natassa: 4,   // teal
  owais: 5,     // red
};

/**
 * Deterministic, visually-distinct color for a person's name. Known team
 * members get pinned colors; everyone else hashes into the curated palette.
 */
export function userColor(name: string | undefined | null): ColorTrio | null {
  const s = String(name ?? "").trim();
  if (!s) return null;
  const key = s.toLowerCase();
  const first = key.split(/\s+/)[0];
  if (key in KNOWN_USERS) return USER_PALETTE[KNOWN_USERS[key]];
  if (first in KNOWN_USERS) return USER_PALETTE[KNOWN_USERS[first]];
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return USER_PALETTE[hash % USER_PALETTE.length];
}

/**
 * Sort rows newest-first. New entries are appended at the bottom of each Google
 * Sheet, so a higher sheet row = more recent. Sorting by _row_number descending
 * puts the freshest data on top — robust across tabs with inconsistent date formats.
 */
export function sortNewestFirst<T extends Record<string, unknown>>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) => Number(b._row_number ?? 0) - Number(a._row_number ?? 0)
  );
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
