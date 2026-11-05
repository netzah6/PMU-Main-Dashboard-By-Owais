// Funnel freeze (owner, 11/04/2026): one click locks everything a visitor sees on
// a client's survey, booking and deposit pages, one click undoes it. A frozen
// funnel loads a saved copy of the engine (onebox_clients.frozen_engine) and a
// snapshot of its page (frozen_page, see onebox-page.ts), never enters a split
// test and ignores the (V1) label.
//
// Stays live, because booking and payment break otherwise: open times, calendar,
// checkout, deposit amount, free booking, video mode, phone, address, pixel.
// Can't be frozen: the AI, texts, ads.
//
// Every /api/onebox/* route the saved engine calls has to keep accepting what it
// sends, because that engine keeps running.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { GoBackSuggestion } from "@/lib/funnel-timeline-view";

export const FROZEN_NO_TEST = "This funnel is frozen, so it can't run a split test. Unfreeze it first on the Freeze screen.";

export async function isFrozen(svc: SupabaseClient, slug: string): Promise<boolean> {
  const { data } = await svc.from("onebox_clients").select("frozen_engine").eq("slug", slug).maybeSingle();
  return data?.frozen_engine != null;
}

export type MonthStat = { l: number; d: number };

export type FreezeStatRow = {
  slug: string;
  client_name: string;
  status: string;
  template: string | null;
  free_booking: boolean;
  deposit_url: string | null;
  frozen_engine: number | null;
  frozen_at: string | null;
  business: string | null;
  owner_name: string | null;
  client_status: string | null;
  months: Record<string, MonthStat>;
  before_leads: number;
  before_deposits: number;
  leads30: number;
  deposits30: number;
  picks30: number;
  page_leads30: number;
  last_lead: string | null;
};

export const pct = (d: number, l: number): number | null => (l > 0 ? +((100 * d) / l).toFixed(1) : null);

const SHORT_MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthLabel = (key: string) => SHORT_MONTH[Number(key.slice(5, 7)) - 1] ?? key;

/* Days run on Pacific time, like the sheet's dates and the stats SQL. */
const laDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

export const laMonth = (d: Date) => laDate(d).slice(0, 7);

export function monthKey(now: Date, back: number): string {
  const [y, m] = laDate(now).split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 - back, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/* "Had a good rate and then fell" (owner, 11/05/2026): the best 2 full months in
   a row against the last 30 days. It is a list to look at, not a verdict: about half
   of the falls this size happen by chance, and ads or the AI can be the cause. */
export const FELL = { minPeakRate: 5, minPeakLeads: 60, minMonthLeads: 15, minNowLeads: 40, keptAtMost: 0.6 };

export type Peak = { from: string; to: string; l: number; d: number };

const nextMonth = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
const dayBefore = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

export function findPeak(months: Record<string, MonthStat>, now: Date): Peak | null {
  const keys = Object.keys(months).filter((k) => months[k].l > 0).sort();
  const cutoff = dayBefore(laDate(now), 30);
  /* A month counts once it has been over for 30 days, so it can't overlap "now".
     The first month never counts: it is usually a partial one. */
  const counts = (k: string) => !!months[k] && k !== keys[0] && months[k].l >= FELL.minMonthLeads && dayBefore(`${nextMonth(k)}-01`, 1) <= cutoff;
  let best: Peak | null = null;
  for (const from of keys) {
    const to = nextMonth(from);
    if (!counts(from) || !counts(to)) continue;
    const l = months[from].l + months[to].l;
    const d = months[from].d + months[to].d;
    if (l < FELL.minPeakLeads) continue;
    if (!best || d / l >= best.d / best.l) best = { from, to, l, d };
  }
  return best;
}

export const peakLabel = (p: Peak) => `${monthLabel(p.from)}–${monthLabel(p.to)} ${p.to.slice(0, 4)}`;

export function fellFromPeak(peak: Peak | null, leads30: number, deposits30: number, clientStatus: string | null): boolean {
  if (!peak || (clientStatus ?? "") !== "live" || leads30 < FELL.minNowLeads) return false;
  const best = (100 * peak.d) / peak.l;
  return best >= FELL.minPeakRate && (100 * deposits30) / leads30 <= best * FELL.keptAtMost;
}

/* The best months as times, for looking up the pages saved back then. Pacific
   midnight, give or take the daylight-saving hour. */
export const peakWindow = (p: Peak) => ({ start: `${p.from}-01T08:00:00Z`, end: `${nextMonth(p.to)}-01T08:00:00Z` });

/* Which saved page was live for most of that time. Versions newest first, all
   saved before the window's end; a page stays live until the next one is saved. */
export function pickPeakVersion<T extends { saved_at: string }>(versions: T[], startIso: string, endIso: string): T | null {
  const start = Date.parse(startIso);
  let until = Date.parse(endIso);
  let best: T | null = null;
  let bestMs = 0;
  for (const v of versions) {
    const savedAt = Date.parse(v.saved_at);
    const ms = until - Math.max(savedAt, start);
    if (ms > bestMs) { best = v; bestMs = ms; }
    until = Math.min(until, savedAt);
    if (until <= start) break;
  }
  return best;
}

export type HistoryEntry = { action: "freeze" | "unfreeze" | "decline" | "undecline" | "accept" | "restore" | "goback"; at: string; by: string | null; engine?: number; leads?: number | null; deposits?: number | null; changes?: DriftItem[] };

export type DriftItem = { key: string; label: string; from?: string; to?: string };

export type BoardRow = {
  slug: string;
  business: string;
  owner: string;
  matched: boolean;
  version: string;
  clientStatus: string;
  freeBooking: boolean;
  payLinkElsewhere: boolean;
  months: { m: string; l: number; d: number }[];
  before: { l: number; d: number };
  now: { l: number; d: number; picks: number; pageLeads: number };
  lastLead: string | null;
  goBack: GoBackSuggestion | null;
  /* Best 2 months in a row, and whether the last 30 days are far below them. */
  peak: Peak | null;
  fell: boolean;
  /* The page saved during those best months, when one exists. */
  peakPage: { id: number; sig: string; savedAt: string } | null;
  suggested: { at: string; l: number | null; d: number | null } | null;
  declined: { at: string; note: string | null } | null;
  frozen: { engine: number; at: string | null; by: string | null; l: number | null; d: number | null } | null;
  drift: DriftItem[];
  /* The page kept until the last Unfreeze, so a misclick can be put back. */
  restorable: { at: string | null } | null;
  history: HistoryEntry[];
};

export type Board = {
  engine: number;
  suggestionsFailed: boolean;
  others: { l: number; d: number };
  rows: BoardRow[];
};
