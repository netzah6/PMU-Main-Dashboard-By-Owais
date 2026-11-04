import type { ChangeItem } from "@/lib/funnel-timeline";

// The Timeline screen's numbers. Safe to import from the browser: no server code.

/* l = leads, b = leads on the one-box page, p = picked a time, d = deposits. */
export type DayCounts = { l: number; b: number; p: number; d: number };

export const pacificDay = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function sumDays(days: Record<string, DayCounts>, from: string, to: string): DayCounts {
  const out = { l: 0, b: 0, p: 0, d: 0 };
  for (const [day, c] of Object.entries(days)) {
    if (day < from || day > to) continue;
    out.l += c.l; out.b += c.b ?? 0; out.p += c.p; out.d += c.d;
  }
  return out;
}

export const rate = (n: number, l: number): number | null => (l > 0 ? +((100 * n) / l).toFixed(1) : null);

/* Picked a time per 100 leads on the page. A returning person can pick with no new
   lead, so a short window can pass 100: that isn't a real rate, so it shows blank. */
export const bookingRate = (c: DayCounts): number | null => (c.p > c.b ? null : rate(c.p, c.b));

/* Below this many leads a rate says little. */
export const MIN_LEADS = 30;
/* Strict on purpose: with 138 funnels a looser test would flag several every day
   with nothing wrong. Roughly 1 in 100 by chance, a bit more at very small counts. */
const FALL_Z = 2.33;

export type Fall = { what: "booking" | "deposit" | "both" };

const fellBy = (nowN: number, nowL: number, beforeN: number, beforeL: number) => {
  const pooled = (nowN + beforeN) / (nowL + beforeL);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / nowL + 1 / beforeL));
  return se > 0 && (beforeN / beforeL - nowN / nowL) / se >= FALL_Z;
};

/* Booking over 14 days vs the 14 before. Deposits are few, so 28 vs 28. A (V1)
   funnel has no calendar, so its booking isn't judged. */
export function flagFall(n14: DayCounts, b14: DayCounts, n28: DayCounts, b28: DayCounts, isV1: boolean): Fall | null {
  const booking = !isV1 && n14.b >= MIN_LEADS && b14.b >= MIN_LEADS && fellBy(n14.p, n14.b, b14.p, b14.b);
  const deposit = n28.l >= MIN_LEADS && b28.l >= MIN_LEADS && fellBy(n28.d, n28.l, b28.d, b28.l);
  return booking && deposit ? { what: "both" } : booking ? { what: "booking" } : deposit ? { what: "deposit" } : null;
}

/* The 14 days before a change vs up to 14 days after it, whatever else changed in
   between: most funnels get under 3 leads a day, and page versions, Instagram and
   reviews change often, so the time between two changes is usually too short to read. */
export type ChangeWindows = { before: DayCounts; after: DayCounts; afterDays: number };

export function changeWindows(days: Record<string, DayCounts>, changeDay: string, today: string): ChangeWindows {
  const lastDay = addDays(changeDay, 13);
  const end = lastDay < today ? lastDay : today;
  return {
    before: sumDays(days, addDays(changeDay, -14), addDays(changeDay, -1)),
    after: sumDays(days, changeDay, end),
    afterDays: Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${changeDay}T00:00:00Z`)) / 86_400_000) + 1,
  };
}

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
  /* False if this page version's file was never saved: it can't come back. */
  engineSaved: boolean;
  /* Proves the saved-page preview link came from this screen. */
  previewSig: string;
  windows: ChangeWindows | null;
};

export type TimelineNote = { id: number; at: string; note: string; allFunnels: boolean };

export type TimelineDetail = { versions: TimelineVersion[]; notes: TimelineNote[] };
