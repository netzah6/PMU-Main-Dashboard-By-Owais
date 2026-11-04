import type { ChangeItem } from "@/lib/funnel-timeline";

// The Timeline screen's numbers. Safe to import from the browser: no server code.

export type DayCounts = { l: number; p: number; d: number };

export const pacificDay = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

export function sumDays(days: Record<string, DayCounts>, from: string, to: string): DayCounts {
  const out = { l: 0, p: 0, d: 0 };
  for (const [day, c] of Object.entries(days)) {
    if (day < from || day > to) continue;
    out.l += c.l; out.p += c.p; out.d += c.d;
  }
  return out;
}

export const rate = (n: number, l: number): number | null => (l > 0 ? +((100 * n) / l).toFixed(1) : null);

/* Below this many leads a rate says little, so nothing is flagged. */
export const MIN_LEADS = 30;
/* "Fell": down to 70% or less of the 14 days before. */
const FALL_RATIO = 0.7;

export type Fall = { what: "booking" | "deposit" | "both" };

export function flagFall(now: DayCounts, before: DayCounts): Fall | null {
  if (now.l < MIN_LEADS || before.l < MIN_LEADS) return null;
  const booking = before.p > 0 && now.p / now.l <= (before.p / before.l) * FALL_RATIO;
  const deposit = before.d > 0 && now.d / now.l <= (before.d / before.l) * FALL_RATIO;
  return booking && deposit ? { what: "both" } : booking ? { what: "booking" } : deposit ? { what: "deposit" } : null;
}

/* Deposits land up to about 7 days after the lead (315 of 328 did, 09/15-10/15/2026),
   so a period younger than that is still counting. */
export function periodStats(days: Record<string, DayCounts>, from: string, to: string, today: string): PeriodStats {
  const c = sumDays(days, from, to);
  const age = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${to}T00:00:00Z`)) / 86_400_000;
  return { ...c, from, to, stillCounting: age < 7 };
}

export type PeriodStats = DayCounts & { from: string; to: string; stillCounting: boolean };

export type TimelineRow = {
  slug: string;
  business: string;
  owner: string;
  version: string;
  clientStatus: string;
  freeBooking: boolean;
  last14: DayCounts;
  prev14: DayCounts;
  fall: Fall | null;
  lastChange: { at: string; changes: ChangeItem[] } | null;
  lockedAt: string | null;
};

export type TimelineBoard = { engine: number; rows: TimelineRow[] };

export type TimelineVersion = {
  id: number;
  savedAt: string;
  engine: number;
  frozen: boolean;
  changes: ChangeItem[];
  isNow: boolean;
  samePageAsNow: boolean;
  stats: PeriodStats;
};

export type TimelineNote = { id: number; at: string; note: string; allFunnels: boolean };

export type TimelineDetail = { versions: TimelineVersion[]; notes: TimelineNote[] };
