import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Parse a date string from Google Sheets (DD/MM/YYYY, MM/DD/YYYY, ISO, etc.)
 * and return a human-readable string.
 *
 * monthFirst: how to read ambiguous X/Y/YYYY dates (both parts ≤ 12).
 * The master sheet writes day-first ("25/7/2025" = Jul 25 — the default);
 * the tracking sheet writes US month-first ("07/14/2025" = Jul 14) — pass
 * monthFirst=true there. Unambiguous dates resolve themselves either way.
 */
export function formatDate(dateStr: string | undefined | null, monthFirst = false): string {
  if (!dateStr || dateStr === "") return "—";
  const s = String(dateStr).trim();

  // D/M/YYYY or M/D/YYYY, with an optional trailing note (e.g. " (Launch)")
  const dmY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(.*)$/.exec(s);
  if (dmY) {
    const a = parseInt(dmY[1], 10);
    const b = parseInt(dmY[2], 10);
    const y = parseInt(dmY[3], 10);
    const suffix = (dmY[4] ?? "").trim();
    let d: number, m: number;
    if (a > 12) { d = a; m = b; }        // 25/7 → day-first, unambiguous
    else if (b > 12) { m = a; d = b; }   // 7/30 → month-first, unambiguous
    else if (monthFirst) { m = a; d = b; }
    else { d = a; m = b; }
    const date = new Date(y, m - 1, d);
    if (!isNaN(date.getTime())) {
      const out = date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      return suffix ? `${out} ${suffix}` : out;
    }
  }

  // M/D without a year (e.g. "10/23") — don't let JS invent year 2001.
  if (/^\d{1,2}\/\d{1,2}$/.test(s)) return s;

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

// ONE color per team member, the same on every tab (owner, 11/17/2026: "in any
// of the dashboard that there is the name Nicolas it will have the same color
// in every tab ... I want the colors between the team members to show a color
// difference, not like 2 colors that look close to each other").
//
// Every person is PINNED — no hashing. (The old hash gave Dana = Natassa,
// Jennifer = Francisco, Diego = Stephanie and Mayela = Marie.) People who work
// in the same column get the most different hues:
//   Assigned coaches: Stephanie blue · Nicolas yellow · Francisco green ·
//                     Viridiana pink · Dana orange
//   Media buyer:      Marie purple
//   Sales:            Jennifer charcoal · Diego crimson · Maria brown
// A NEW team member shows neutral gray until pinned here — add them with a hue
// nobody else has. Chips are SOLID fills: pastel tints all looked alike (they
// measured 3–5× closer than solid colors).
//   bg/text/border = the chip;  ink = the same color as plain text on white.
type ColorTrio = { text: string; bg: string; border: string; ink: string };
const solid = (bg: string, ink: string, dark = false): ColorTrio => ({ bg, border: bg, text: dark ? "#1f2937" : "#ffffff", ink });
const TEAM_COLORS: Record<string, ColorTrio> = {
  stephanie: solid("#2563eb", "#1d4ed8"),       // blue
  nicolas:   solid("#facc15", "#a16207", true), // yellow
  francisco: solid("#16a34a", "#15803d"),       // green
  marie:     solid("#9333ea", "#7e22ce"),       // purple
  viridiana: solid("#ec4899", "#be185d"),       // pink
  dana:      solid("#ea580c", "#c2410c"),       // orange
  jennifer:  solid("#1f2937", "#1f2937"),       // charcoal
  diego:     solid("#be123c", "#be123c"),       // crimson
  maria:     solid("#92400e", "#78350f"),       // brown
  mayela:    solid("#0d9488", "#0f766e"),       // teal
  natassa:   solid("#a3e635", "#4d7c0f", true), // lime
  owais:     solid("#38bdf8", "#0369a1", true), // sky
};
const UNKNOWN_PERSON: ColorTrio = { text: "#475569", bg: "#f1f5f9", border: "#cbd5e1", ink: "#64748b" }; // not pinned yet

/** The person's key: first name, lowercase. "Nicolas", "nicolas@x.com", "Jennifer Roman" → "nicolas" / "jennifer". */
export function teamKey(name: string | undefined | null): string {
  return String(name ?? "").trim().toLowerCase().split("@")[0].split(/[\s._-]+/)[0] ?? "";
}

/**
 * The team member's color — the same on every tab. Pinned per person;
 * someone not pinned yet gets neutral gray (never a look-alike of a teammate).
 */
export function userColor(name: string | undefined | null): ColorTrio | null {
  const k = teamKey(name);
  if (!k) return null;
  return TEAM_COLORS[k] ?? UNKNOWN_PERSON;
}

/**
 * Sort rows newest-first. New entries are appended at the bottom of each Google
 * Sheet, so a higher sheet row = more recent. Sorting by _row_number descending
 * puts the freshest data on top — robust across tabs with inconsistent date formats.
 */
export function sortNewestFirst<T extends Record<string, unknown>>(rows: T[]): T[] {
  // Sort by the row's actual Date — NOT by sheet position. Position lied on
  // 2026-08-20: new deposits were inserted mid-sheet (rows 61-71) by Google's
  // table detection, and position-sorting buried that day's payments among
  // March rows. Date formats seen: dd/mm/yyyy (current era), d/m/yyyy with
  // single digits (Jan-2026 era of the LTV sheet), and ISO strings (spring
  // era). Slash dates resolve day-first like formatDate — leaving single-digit
  // dates to new Date() read them US-style, so "10/1/2026" (Jan 10) became
  // Oct 1 and the whole January era floated above August. Rows without a
  // parseable date fall back to sheet position.
  const ts = (r: Record<string, unknown>): number => {
    const s = String(r["Date"] ?? r["Signed Date"] ?? "");
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    let d: Date;
    if (m) {
      const a = parseInt(m[1], 10), b = parseInt(m[2], 10), y = parseInt(m[3], 10);
      const [day, mon] = b > 12 ? [b, a] : [a, b]; // day-first unless impossible
      d = mon <= 12 ? new Date(Date.UTC(y, mon - 1, day)) : new Date(NaN);
    } else d = new Date(s);
    return Number.isNaN(d.getTime()) ? Number(r._row_number ?? 0) : d.getTime();
  };
  return [...rows].sort((a, b) => {
    const diff = ts(b) - ts(a);
    return diff !== 0 ? diff : Number(b._row_number ?? 0) - Number(a._row_number ?? 0);
  });
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
