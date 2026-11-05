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
import { isOurChange, type GoBackSuggestion } from "@/lib/funnel-timeline-view";
import type { ChangeItem } from "@/lib/funnel-timeline";

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

/* "Had a good rate and then fell recently" (owner, 11/05/2026): the best 2 full
   months in a row, from the last 6 months, against the last 30 days. It is a list to
   look at, not a verdict: tested on real data, more than half of the falls this size
   happen by chance, and ads or the AI can be the cause. */
export const FELL = { minPeakRate: 5, minPeakLeads: 60, minMonthLeads: 15, minNowLeads: 40, keptAtMost: 0.6, maxAgeDays: 185 };

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
  const oldest = dayBefore(laDate(now), FELL.maxAgeDays);
  const lastDay = (k: string) => dayBefore(`${nextMonth(k)}-01`, 1);
  /* A month counts once it has been over for 30 days, so it can't overlap "now".
     The first month never counts: it is usually a partial one. */
  const counts = (k: string) => !!months[k] && k !== keys[0] && months[k].l >= FELL.minMonthLeads && lastDay(k) <= cutoff;
  let best: Peak | null = null;
  for (const from of keys) {
    const to = nextMonth(from);
    /* "Recently": best months from long ago would keep a client on the list for good. */
    if (!counts(from) || !counts(to) || lastDay(to) < oldest) continue;
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

/* Facts on a fallen client's card that point away from the page (owner, 11/04/2026:
   "not the clients that have an ad account disabled or their leads volume went down"). */
export function adsHints(peak: Peak, leads30: number, lastLead: string | null, now: Date): string[] {
  const out: string[] = [];
  const then = Math.round(peak.l / 2);
  if (leads30 < then * 0.6) out.push(`Leads are down too: ${leads30} in 30 days, about ${then} a month back then. Check the ads first.`);
  if (lastLead) {
    /* Full days with no lead: today has only just started, so it doesn't count. */
    const quietDays = Math.round((Date.parse(`${laDate(now)}T00:00:00Z`) - Date.parse(`${lastLead}T00:00:00Z`)) / 86_400_000) - 1;
    /* Quiet for long enough that 4+ leads should have come at this client's usual pace. */
    if ((leads30 / 30) * quietDays >= 4) out.push(`No new lead since ${lastLead.slice(5, 7)}/${lastLead.slice(8, 10)}/${lastLead.slice(0, 4)}. The ads may be off.`);
  }
  return out;
}

/* Which saved page was live for most of the best months, and whether it is still
   today's page. A row is saved for any change (budget, phone, Instagram…), so rows
   are joined into one page until a row where we changed the page itself. */
export function pickPeakVersion<T extends { saved_at: string; changes?: ChangeItem[] | null }>(versions: T[], startIso: string, endIso: string): { version: T; sameAsNow: boolean } | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  const rows = [...versions].sort((a, b) => a.saved_at.localeCompare(b.saved_at));
  const pages: { from: number; to: number; shown: T }[] = [];
  for (const v of rows) {
    const at = Date.parse(v.saved_at);
    if (!pages.length || (v.changes ?? []).some(isOurChange)) {
      if (pages.length) pages[pages.length - 1].to = at;
      pages.push({ from: at, to: Infinity, shown: v });
    } else if (at < end) {
      pages[pages.length - 1].shown = v;
    }
  }
  let best = -1;
  let bestMs = 0;
  pages.forEach((p, i) => {
    const ms = Math.min(p.to, end) - Math.max(p.from, start);
    if (ms > bestMs) { best = i; bestMs = ms; }
  });
  return best < 0 ? null : { version: pages[best].shown, sameAsNow: best === pages.length - 1 };
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
  /* What else could explain the fall: leads down, or no new lead for days. */
  fellHints: string[];
  /* The page saved during those best months, when one exists. */
  peakPage: { id: number; sig: string; savedAt: string; sameAsNow: boolean } | null;
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
