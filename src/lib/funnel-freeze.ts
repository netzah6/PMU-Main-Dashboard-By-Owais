// Funnel freeze (owner, 11/04/2026): one click keeps a client's survey, booking
// and deposit pages exactly as they are today, one click undoes it. A frozen
// funnel loads a saved copy of the engine (onebox_clients.frozen_engine), never
// enters a split test and ignores the (V1) label.
//
// Because frozen funnels keep running an old engine, every /api/onebox/* route
// that engine calls has to keep accepting what it sends. Any fleet-wide change
// to funnel pages outside the engine has to skip them too.

import type { SupabaseClient } from "@supabase/supabase-js";

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
  last_lead: string | null;
};

export const pct = (d: number, l: number): number | null => (l > 0 ? +((100 * d) / l).toFixed(1) : null);

const SHORT_MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthLabel = (key: string) => SHORT_MONTH[Number(key.slice(5, 7)) - 1] ?? key;

export function monthKey(now: Date, back: number): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/* The suggestion rule, written out from the 11/04/2026 study: a V3 client with
   ads running, a history from before the two months being judged, and a steady
   deposit rate in both of the last two full months. */
export const RULE = { minRate: 6, minMonthLeads: 30, minHistoryLeads: 40, leadWithinDays: 3 };

export type RuleResult = { ok: boolean; why: string };

export function checkRule(row: FreezeStatRow, version: string, now: Date): RuleResult {
  const a = monthKey(now, 2);
  const b = monthKey(now, 1);
  const ma = row.months[a] ?? { l: 0, d: 0 };
  const mb = row.months[b] ?? { l: 0, d: 0 };
  const ra = pct(ma.d, ma.l);
  const rb = pct(mb.d, mb.l);
  const history = Object.entries(row.months).reduce((s, [m, v]) => (m < a ? s + v.l : s), 0);
  const names = `${monthLabel(a)} and ${monthLabel(b)}`;
  if (!/v3/i.test(version)) return { ok: false, why: "Not on V3" };
  if ((row.client_status ?? "") !== "live") return { ok: false, why: "Client isn't live" };
  const lastLead = row.last_lead ? Date.parse(`${row.last_lead}T00:00:00Z`) : 0;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (!lastLead || today - lastLead > RULE.leadWithinDays * 86_400_000) return { ok: false, why: `No new lead in ${RULE.leadWithinDays} days` };
  if (history < RULE.minHistoryLeads) return { ok: false, why: `Under ${RULE.minHistoryLeads} leads before ${monthLabel(a)}` };
  if (ma.l < RULE.minMonthLeads || mb.l < RULE.minMonthLeads) return { ok: false, why: `Under ${RULE.minMonthLeads} leads in ${names}` };
  /* Compared unrounded: 4 of 67 is 5.97%, which must not pass as "6%". */
  if ((100 * ma.d) / ma.l < RULE.minRate || (100 * mb.d) / mb.l < RULE.minRate) return { ok: false, why: `Under ${RULE.minRate}% in ${names}` };
  return { ok: true, why: `${ra}% in ${monthLabel(a)}, ${rb}% in ${monthLabel(b)}, ads running, history before ${monthLabel(a)}` };
}

/* Freezing locks today's page, so it can't bring a fallen rate back: the screen
   says so instead of inviting the click. */
export function hasFallen(row: FreezeStatRow): boolean {
  const before = pct(row.before_deposits, row.before_leads);
  const now = pct(row.deposits30, row.leads30);
  return before != null && now != null && row.before_leads >= 40 && row.leads30 >= 40 && before >= 5 && now <= before / 2;
}

export type HistoryEntry = { action: "freeze" | "unfreeze" | "decline" | "undecline"; at: string; by: string | null; engine?: number; leads?: number | null; deposits?: number | null };

export type BoardRow = {
  slug: string;
  business: string;
  owner: string;
  version: string;
  clientStatus: string;
  months: { m: string; l: number; d: number }[];
  before: { l: number; d: number };
  now: { l: number; d: number; picks: number };
  lastLead: string | null;
  rule: RuleResult;
  fell: boolean;
  suggested: { at: string; l: number | null; d: number | null } | null;
  declined: { at: string; note: string | null } | null;
  frozen: { engine: number; at: string | null; by: string | null; l: number | null; d: number | null } | null;
  history: HistoryEntry[];
};

export type Board = {
  engine: number;
  ruleMonths: string[];
  others: { l: number; d: number };
  rows: BoardRow[];
};
