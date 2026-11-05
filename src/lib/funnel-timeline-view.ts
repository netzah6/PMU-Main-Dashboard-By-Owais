import type { ChangeItem } from "@/lib/funnel-timeline";

// The Timeline screen's numbers. Safe to import from the browser: no server code.

/* l = leads, b = leads on the one-box page, p = picked a time, d = deposits. */
export type DayCounts = { l: number; b: number; p: number; d: number };

const PACIFIC_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });
export const pacificDay = (d: Date) => PACIFIC_DAY.format(d);

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

export const zFell = (nowN: number, nowL: number, beforeN: number, beforeL: number) => {
  const pooled = (nowN + beforeN) / (nowL + beforeL);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / nowL + 1 / beforeL));
  return se > 0 ? (beforeN / beforeL - nowN / nowL) / se : 0;
};
const fellBy = (nowN: number, nowL: number, beforeN: number, beforeL: number) => zFell(nowN, nowL, beforeN, beforeL) >= FALL_Z;

/* Booking over 14 days vs the 14 before. Deposits are few, so 28 vs 28. A (V1)
   funnel has no calendar, so its booking isn't judged. */
export function flagFall(n14: DayCounts, b14: DayCounts, n28: DayCounts, b28: DayCounts, isV1: boolean): Fall | null {
  const booking = !isV1 && n14.b >= MIN_LEADS && b14.b >= MIN_LEADS && fellBy(n14.p, n14.b, b14.p, b14.b);
  const deposit = n28.l >= MIN_LEADS && b28.l >= MIN_LEADS && fellBy(n28.d, n28.l, b28.d, b28.l);
  return booking && deposit ? { what: "both" } : booking ? { what: "booking" } : deposit ? { what: "deposit" } : null;
}

/* The suggestion to go back (owner, 11/04/2026): "funnels that had a high percentage
   and then fell because of a change we did, only the ones we can reverse". Tested on
   real data: every funnel's rate wobbles, and each one gets many changes, so a looser
   rule would suggest several a month with nothing wrong. */
export const GO_BACK_Z = 2.58;
const MIN_DAYS_AFTER = 7;
/* "Had a high percentage": a funnel that was already weak has no good page to return to. */
export const HIGH_BOOKING = 50;
export const HIGH_DEPOSIT = 5;
/* Leads moving this much point to the ads, not the page. */
const MIN_VOLUME_KEPT = 0.6;
const MAX_VOLUME_RISE = 1.5;
/* It has to be still low today: a funnel that recovered needs nothing. */
const STILL_LOW = 0.75;

/* Instagram and reviews refresh on their own. Everything else that can come back is
   something we changed. */
export const AUTOMATIC_KEYS = new Set(["instagram", "reviews"]);
export const isOurChange = (c: ChangeItem) => c.restorable && !AUTOMATIC_KEYS.has(c.key);
/* A change that going back can't undo (prices, deposit, budget, label…) may be the real
   cause, so that period isn't blamed on the page. */
export const isOtherCause = (c: ChangeItem) => !c.restorable && c.key !== "frozen";

export type ChangeFall = {
  what: Fall["what"];
  z: number;
  before: DayCounts;
  after: DayCounts;
  afterDays: number;
  depositBefore: DayCounts;
  depositAfter: DayCounts;
};

/* 5+ days in a row with real traffic and nobody picking: something is broken (account,
   calendar), and an old page wouldn't fix that. */
function hadBookingOutage(days: Record<string, DayCounts>, from: string, to: string): boolean {
  let run = 0;
  let leads = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const c = days[d];
    if (c && c.p > 0) { run = 0; leads = 0; continue; }
    run++;
    leads += c?.b ?? 0;
    if (run >= 5 && leads >= 15) return true;
  }
  return false;
}

export function fellAfterChange(days: Record<string, DayCounts>, changeDay: string, today: string): ChangeFall | null {
  const { before, after, afterDays } = changeWindows(days, changeDay, today);
  if (afterDays < MIN_DAYS_AFTER || before.l < MIN_LEADS || after.l < MIN_LEADS) return null;
  const volume = (after.l / afterDays) / (before.l / 14);
  if (volume < MIN_VOLUME_KEPT || volume > MAX_VOLUME_RISE) return null;
  if (hadBookingOutage(days, changeDay, today)) return null;
  /* Deposits are few, so they get twice the days on each side. */
  const dEnd = addDays(changeDay, 27) < today ? addDays(changeDay, 27) : today;
  const dBefore = sumDays(days, addDays(changeDay, -28), addDays(changeDay, -1));
  const dAfter = sumDays(days, changeDay, dEnd);
  const recent14 = sumDays(days, addDays(today, -13), today);
  const recent28 = sumDays(days, addDays(today, -27), today);

  const bookingZ = before.b >= MIN_LEADS && after.b >= MIN_LEADS ? zFell(after.p, after.b, before.p, before.b) : 0;
  const bookingBefore = rate(before.p, before.b) ?? 0;
  const booking = bookingZ >= GO_BACK_Z && bookingBefore >= HIGH_BOOKING
    && (rate(recent14.p, recent14.b) ?? 100) <= bookingBefore * STILL_LOW;

  /* Most leads have to come through this page, or going back can't be what helps. */
  const depositZ = dBefore.l >= MIN_LEADS && dAfter.l >= MIN_LEADS && dAfter.b >= dAfter.l * 0.7 ? zFell(dAfter.d, dAfter.l, dBefore.d, dBefore.l) : 0;
  const depositBefore = rate(dBefore.d, dBefore.l) ?? 0;
  const deposit = depositZ >= GO_BACK_Z && depositBefore >= HIGH_DEPOSIT && (rate(recent28.d, recent28.l) ?? 100) <= depositBefore * STILL_LOW;

  if (!booking && !deposit) return null;
  /* Fewer people booking but more paying isn't a fall worth reversing: deposits are what pays. */
  if (!deposit && dBefore.l >= MIN_LEADS && (rate(dAfter.d, dAfter.l) ?? 0) >= depositBefore) return null;
  return {
    what: booking && deposit ? "both" : booking ? "booking" : "deposit",
    z: Math.max(booking ? bookingZ : 0, deposit ? depositZ : 0),
    before, after, afterDays, depositBefore: dBefore, depositAfter: dAfter,
  };
}

export type GoBackSuggestion = ChangeFall & {
  /* The saved page from just before the change, and when it was saved. */
  versionId: number;
  savedAt: string;
  previewSig: string;
  changeAt: string;
  changes: ChangeItem[];
  /* Every page change since then, which going back also undoes. */
  undoes: string[];
};

const shownRate = (r: number | null) => (r == null ? "—" : `${r}%`);

export function goBackWhy(g: ChangeFall): string {
  const booking = `booking ${g.what === "deposit" ? "went" : "fell"} from ${shownRate(bookingRate(g.before))} to ${shownRate(bookingRate(g.after))}`;
  const deposit = `deposit ${g.what === "booking" ? "went" : "fell"} from ${shownRate(rate(g.depositBefore.d, g.depositBefore.l))} to ${shownRate(rate(g.depositAfter.d, g.depositAfter.l))}`;
  return g.what === "deposit" ? `${deposit}, ${booking}` : `${booking}, ${deposit}`;
}

/* Not page values, so "stays live" would mean nothing on them. */
const NOT_ON_PAGE = new Set(["frozen", "status", "label", "budget", "test"]);
export const changeText = (c: ChangeItem) =>
  `${c.to !== undefined ? `${c.label}: ${c.from || "empty"} → ${c.to || "empty"}` : `${c.label} changed`}${c.restorable || NOT_ON_PAGE.has(c.key) ? "" : " (stays live)"}`;

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
  goBack: GoBackSuggestion | null;
  lastChange: { at: string; changes: ChangeItem[] } | null;
  lockedAt: string | null;
};

export type TimelineBoard = { engine: number; rows: TimelineRow[]; suggestionsFailed: boolean };

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
