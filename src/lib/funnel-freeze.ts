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

/* Freezing locks today's page, so it can't bring a fallen rate back: the screen
   says so instead of inviting the click. */
export function hasFallen(row: FreezeStatRow): boolean {
  const before = pct(row.before_deposits, row.before_leads);
  const now = pct(row.deposits30, row.leads30);
  return before != null && now != null && row.before_leads >= 40 && row.leads30 >= 40 && before >= 5 && now <= before / 2;
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
  fell: boolean;
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
  others: { l: number; d: number };
  rows: BoardRow[];
};
