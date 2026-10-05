import { createServiceClient } from "@/lib/supabase/server";
import { getAgencyFinance } from "@/lib/ceo-finance";
import { nk, sameClient } from "@/lib/ceo-growth";

/* Client Health (owner, 2026-10-05): "who is green, who is orange, who is
   red … from the day they actually started they need to get bookings and
   make money … a return on every single penny they invest with us."

   Per LIVE client:
     invested = what they paid us (payment ledger before 2026 + the Financing
                sheet's PAID rows from 2026) + their Facebook ad spend (tracked
                campaigns, all-time) + for pay-per-show clients the $50
                deposits we kept
     earned   ≈ clients booked × their service price
     return   = earned ÷ invested  ("$2.40 back for every $1")
   …plus what is going wrong RIGHT NOW (ads stopped, no leads, no deposits,
   leads waiting, upset, payment trouble). Every light comes with the reasons
   and the next step, so a coach knows what to do, not just the colour.

   Raw facts come from the client_health_base view (one row per Live client,
   service role only — supabase/client-health.sql); 2026 payments from the
   Financing workbook. */

/* "unknown" (owner, 2026-10-05): live 2+ months but we can't see how many
   they booked — maybe they book fine and just don't move leads to the booked
   stage. Not red; its own section until the count is known. */
export type Light = "green" | "orange" | "red" | "unknown";
export type Reason = { key: string; light: Light | "info"; text: string; next?: string };

export type ClientHealth = {
  ownerKey: string;
  owner: string;
  business: string;
  coach: string;
  version: string;
  light: Light;
  reasons: Reason[];
  start: { date: string | null; source: string; days: number | null; cameBack: boolean };
  /** Went live = the day their first real lead came in (tests and imports left out). */
  live: { firstLead: string | null; days: number | null; note: string | null };
  /** Leads: one per person per month (the one-box writes some leads twice). */
  leads: { last7: number; last30: number; budget: number | null; budgetNote: string | null; goal: number | null;
    /** Goal for the last 30 days (pro-rated while live < 30 days) and leads ÷ that; ratio is null in the first 14 days. */
    expected30: number | null; ratio: number | null; sinceLive: number | null; avgPerMonth: number | null };
  /** Bookings: one per person, from GHL appointments (trustworthy from 2026-07-30). */
  bookings: { last30: number; pct30: number | null; since: number | null; leadsSince: number | null; pctSince: number | null; sinceLabel: string | null; coachPct: number | null; coachAsOf: string | null;
    /** The one booking % for the list: GHL where bookings land there (V3), else the coach log. */
    rowPct: number | null; rowSource: string };
  months: Array<{ ym: string; leads: number | null; goal: number | null; bookings: number | null; deposits: number; pct: number | null; partial: boolean }>;
  invested: { total: number; feesBefore2026: number; fees2026: number; ads: number; depositsKept: number };
  booked: { count: number | null; basis: string | null; sessions: number | null; sessionsAsOf: string | null; deposits: number; ghlBookings: number; refunded: number };
  price: { amount: number; source: string; typical: boolean };
  earned: number | null;
  /** null when it can't be judged (no booking data, finance sheet down). */
  roi: number | null;
  recent: { deposits14: number; deposits30: number; depositsPrev30: number; cpl7: number | null; cpl30: number | null };
  ads: { status: string | null; paused: boolean; dailyBudget: number | null; tracked: boolean };
  care: { hotWaiting: number; killPct: number | null; killFixed: boolean; upset: number };
  pay: { status: string | null; thisMonth: number | null; pps: boolean };
  lastTouch: string | null;
};

type Base = Record<string, unknown>;

/* The typical PMU price when a client has none on file (median of the
   prices we do have, 2026-10). Shown with a "≈" and the reason. */
export const TYPICAL_PRICE = 397;
/* No payment or activity for over a year = they left; what comes next is a
   comeback. Shorter gaps are NOT treated as leaving: prepaid 3/6-month plans,
   Fanbasis payments (not in the old ledger) and pay-per-show months leave
   payment gaps too. */
const COMEBACK_GAP_DAYS = 400;
/* Return per $1 at or above this = green. Earned is a floor (first session
   only — touch-ups and repeat clients aren't counted), so 1.5× is solid. */
export const GOOD_RETURN = 1.5;
/* Owner's lead goal (2026-10-05): $20/day → 100 leads a month, $10/day → ~50,
   i.e. 5 leads a month for every $1/day of budget. */
export const LEADS_PER_DOLLAR_DAY = 5;
/* The bookings feed bulk-dumped history on 06-24 and 07-29 — counts are only
   real from the 30th of July; booking % months start in August. */
const BOOKINGS_FROM_MONTH = "2026-08";

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const DAY = 86_400_000;
const todayIso = () => new Date().toISOString().slice(0, 10);
const daysSince = (iso: string) => Math.floor((Date.parse(`${todayIso()}T00:00:00Z`) - Date.parse(`${iso.slice(0, 10)}T00:00:00Z`)) / DAY);
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const pad = (n: number) => String(n).padStart(2, "0");
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const pct = (a: number, b: number) => (b > 0 ? a / b : null);
/* "$15/day", "$20 a day", "20" → 15 / 20; anything else → null. */
const parseBudget = (t: unknown) => { const m = String(t ?? "").match(/\d+(?:\.\d+)?/); const n = m ? Number(m[0]) : NaN; return n >= 3 && n <= 1000 ? n : null; };

/* "$397", "start at $449", "$600-750" → the first real price; "---", "#REF!",
   "false", "Only want V.1" → none. */
export function parsePrice(t: unknown): number | null {
  const m = String(t ?? "").replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return n >= 50 && n <= 5000 ? n : null;
}

/* "84", "1~" → 84 / 1; "-", "NO DATA", "" → unknown. */
function parseSessions(t: unknown): number | null {
  const m = String(t ?? "").match(/\d+/);
  return m ? Number(m[0]) : null;
}

/* Performance Tracking writes M/D/YYYY, with year typos on old rows — a
   date in the future is a typo, not a check. */
function parseUsDate(t: unknown): string | null {
  const m = String(t ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2])));
  if (Number.isNaN(d.getTime()) || d.getUTCMonth() !== Number(m[1]) - 1) return null;
  return d.getTime() > Date.now() ? null : d.toISOString().slice(0, 10);
}

/* ── Financing payer row → Live client ──
   Names are written loosely: "Hang Le (Sydney)", "Ah Ra Cho (Estee Cho)", the
   business name, or a partner split "Erin 30%" for "Erin Heidecke / Ayesha
   Ali". The alias in brackets is a second name (and is remembered for months
   that leave it out); owner names with "/" or "&" are two people. A row that
   fits two clients is skipped rather than guessed. */
const alias = (s: string) => (s.match(/\(([^)]+)\)/)?.[1] ?? "").trim();
const cleanPayer = (s: string) => s.replace(/\d+(?:\.\d+)?\s*%/g, " ").replace(/\s+/g, " ").trim();
type Who = { key: string; owner: string; parts: string[]; ownerAlias: string; biz: string };
function payerMatches(payerRaw: string, learnedAlias: string, w: Who): "exact" | "loose" | null {
  const payer = cleanPayer(payerRaw);
  const p = nk(payer);
  if (!p) return null;
  if (p === nk(w.owner) || w.parts.some((x) => nk(x) === p) || (w.biz.length > 4 && p === w.biz)) return "exact";
  const names = [alias(payer), learnedAlias].filter(Boolean);
  for (const n of names) if (sameClient(n, w.owner) || w.parts.some((x) => sameClient(n, x)) || (w.ownerAlias && sameClient(n, w.ownerAlias))) return "loose";
  if (w.ownerAlias && sameClient(payer, w.ownerAlias)) return "loose";
  if (sameClient(payer, w.owner) || w.parts.some((x) => sameClient(payer, x))) return "loose";
  // "Erin 30%" — one first name with a split percentage, for a two-person owner row
  if (/%/.test(payerRaw) && !p.includes(" ") && w.parts.length > 1 && w.parts.some((x) => nk(x).split(" ")[0] === p)) return "loose";
  if (w.biz.length > 6 && (p.replace(/ /g, "").includes(w.biz) || (w.biz.includes(p.replace(/ /g, "")) && p.length > 6))) return "loose";
  return null;
}

/* Deposit-funnel clients: V3 (and pay-per-show), where a booked client pays a
   deposit — so "no deposits" really means "no bookings". */
const isDepositProgram = (version: string, pps: boolean) => pps || /v3/i.test(version);

export async function getClientHealth(ownerKeys: Set<string> | null): Promise<{ clients: ClientHealth[]; financeError?: string; unmatchedPayers: number }> {
  const svc = createServiceClient();
  const [{ data, error }, finance] = await Promise.all([
    svc.from("client_health_base").select("*"),
    getAgencyFinance(),
  ]);
  if (error) throw new Error(error.message);
  const all = (data ?? []) as Base[];
  const rows = all.filter((r) => !ownerKeys || ownerKeys.has(String(r.owner_key)));
  const curYm = todayIso().slice(0, 7);

  /* 2026 money per client from every Financing month that exists, matched
     against the WHOLE live roster (not just this coach's book) so a row is
     never given to the wrong client. Only money actually in: rows marked
     Paid / Paid Upfront / PPS, plus unmarked rows of past months (the sheet
     is filled in ahead — this month's blank rows aren't collected yet). */
  const roster: Who[] = all.map((r) => {
    const owner = String(r.owner_name ?? "");
    return { key: String(r.owner_key), owner, parts: owner.replace(/\(.*?\)/g, " ").split(/\s*(?:\/|&|\band\b)\s*/i).map((x) => x.trim()).filter((x) => x.length > 2), ownerAlias: alias(owner), biz: String(r.business_name ?? "").toLowerCase().replace(/\s*-\s*ad\s*account.*$/i, "").replace(/[^a-z0-9]/g, "") };
  });
  const learned = new Map<string, string>(); // "ah ra cho" → "Estee Cho"
  for (const m of finance.months) for (const p of m.payers) { const a = alias(p.name); if (a) learned.set(nk(p.name), a); }
  const matchCache = new Map<string, string | null>();
  let unmatchedPayers = 0;
  const whoPaid = (name: string): string | null => {
    if (matchCache.has(name)) return matchCache.get(name)!;
    const hits = roster.map((w) => ({ w, how: payerMatches(name, learned.get(nk(cleanPayer(name))) ?? "", w) })).filter((h) => h.how);
    const exact = hits.filter((h) => h.how === "exact");
    const pick = exact.length === 1 ? exact[0] : hits.length === 1 ? hits[0] : null;
    const key = pick ? pick.w.key : null;
    if (!pick && hits.length > 1) unmatchedPayers++;
    matchCache.set(name, key);
    return key;
  };
  const fees2026 = new Map<string, Array<{ date: string; amount: number }>>();
  const ppsActive = new Map<string, string[]>(); // pay-per-show months, $0 ones too
  const ppsFlag = new Set<string>();
  for (const m of finance.months.filter((x) => x.ym >= "2026-01")) {
    for (const p of m.payers) {
      const k = whoPaid(p.name);
      if (!k) continue;
      const amount = p.paid + (m.ym < curYm ? p.unmarked : 0);
      if (amount > 0) {
        const date = `${m.ym}-${pad(Math.min(28, p.day ?? 1))}`;
        fees2026.set(k, [...(fees2026.get(k) ?? []), { date, amount }]);
      }
      if (p.pps) ppsFlag.add(k);
    }
    for (const n of m.ppsNames) {
      const k = whoPaid(n);
      if (!k) continue;
      ppsFlag.add(k);
      ppsActive.set(k, [...(ppsActive.get(k) ?? []), `${m.ym}-01`]);
    }
  }

  const clients = rows.map((r): ClientHealth => {
    const ownerKey = String(r.owner_key);
    const version = String(r.version ?? "").replace(/[()]/g, "").trim();
    const payStatus = (r.payment_status as string | null) || null;
    const pps = ppsFlag.has(ownerKey) || /^pps$/i.test(payStatus ?? "");

    /* ── Start ──
       The earliest real date we have for them — unless they left and came
       back: nothing paid and no activity for COMEBACK_GAP_DAYS, then a new
       payment, deposit, lead or pay-per-show month. Then they start again
       on the comeback, so money from an old stint doesn't count against the
       new one. */
    const ledger = ((r.ledger_pays as Array<[string, number | null]> | null) ?? []).filter((x) => x?.[0]);
    const fin = fees2026.get(ownerKey) ?? [];
    const depDatesAll = (r.dep_dates as string[] | null) ?? [];
    // [month, leads, first lead day] from GHL (tests/imports out) and [month, leads, bookings] from the sheets
    const oppMonths = ((r.opp_months as Array<[string, number, string[]]> | null) ?? []);
    const oppDays = oppMonths.flatMap((x) => x[2] ?? []).sort();
    const bizMonths = ((r.biz_months as Array<[string, number, number]> | null) ?? []);
    const timeline = [
      ...ledger.map((x) => x[0]), ...fin.map((x) => x.date), ...(ppsActive.get(ownerKey) ?? []),
      ...depDatesAll, ...oppMonths.map((x) => x[2]?.[0]).filter(Boolean) as string[],
    ].filter((d) => d && d <= todayIso()).sort();
    let comeback: string | null = null;
    for (let i = 1; i < timeline.length; i++) {
      if ((Date.parse(timeline[i]) - Date.parse(timeline[i - 1])) / DAY > COMEBACK_GAP_DAYS) comeback = timeline[i];
    }
    const cands: Array<{ d: string | null; s: string }> = [
      { d: (r.first_paid as string) ?? null, s: "first payment" },
      { d: fin[0]?.date ?? null, s: "first payment" },
      { d: (r.launch_at as string) ?? null, s: "launch call" },
      { d: (r.agreement_at as string) ?? null, s: "agreement" },
      { d: (r.signed_at as string) ?? null, s: "signed agreement" },
    ];
    let start: { d: string; s: string } | null = comeback ? { d: comeback, s: "came back" }
      : (cands.filter((c) => c.d && c.d <= todayIso()).sort((a, b) => a.d!.localeCompare(b.d!))[0] as { d: string; s: string } | undefined) ?? null;
    const firstOppEver = oppDays[0] ?? null;
    if (!start && firstOppEver) start = { d: firstOppEver, s: "first lead" };
    const startDay = start?.d ?? "0000-00-00";
    const days = start ? Math.max(0, daysSince(start.d)) : null;

    /* ── Went live = first real lead ──
       The first GHL lead on/after the start (minus a week — ads often go on
       just before the first payment clears), so a re-used sub-account's old
       leads don't count. Falls back to the leads sheet. */
    const liveFrom = start ? addDays(startDay, -7) : "0000-00-00";
    const sheetFirst = (r.first_sheet_lead as string | null) ?? null;
    let firstLead = oppDays.find((d) => d >= liveFrom) ?? null;
    if (!firstLead && sheetFirst && sheetFirst >= liveFrom) firstLead = sheetFirst;
    let liveNote: string | null = null;
    if (firstLead && firstLead <= "2024-01-20") liveNote = "Live before January 2024 — our lead records start then";
    else if (firstLead && start && !comeback && (Date.parse(firstLead) - Date.parse(startDay)) / DAY > 180) liveNote = "First lead in their current GHL account — earlier leads aren't in our records";
    const daysLive = firstLead ? Math.max(0, daysSince(firstLead)) : null;
    /* Judge time on the account from going live (ads running) — unless the
       first lead we can see is just their move to a new GHL account (then
       they're not new: count from the start). */
    const age = daysLive != null && !liveNote ? daysLive : days;

    // ── Invested (since the start) ──
    const feesBefore2026 = ledger.filter((x) => x[0] < "2026-01-01" && x[0] >= startDay).reduce((t, x) => t + (Number(x[1]) || 0), 0);
    const f26 = fin.filter((x) => x.date.slice(0, 7) >= startDay.slice(0, 7)).reduce((t, x) => t + x.amount, 0);
    const ads = num(r.spent_all) ?? 0;
    const refundsAll = ((r.refunds as Array<[string | null, number]> | null) ?? []);
    const refundsInStint = refundsAll.filter((x) => !x[0] || x[0] >= startDay);
    const depositsKept = pps
      ? Math.max(0, (num(r.dep_amt_since_aug) ?? 0) - refundsAll.filter((x) => x[0] && x[0] >= "2026-08-01").reduce((t, x) => t + (Number(x[1]) || 0), 0))
      : 0;
    const invested = feesBefore2026 + f26 + ads + depositsKept;

    // ── Booked & earned ──
    let sessions = parseSessions(r.sessions);
    let sessionsAsOf = sessions == null ? null : parseUsDate(r.checked);
    // A count from before a comeback belongs to the old stint.
    if (sessions != null && sessionsAsOf && comeback && sessionsAsOf < comeback) { sessions = null; sessionsAsOf = null; }
    const refunded = refundsInStint.length;
    const deposits = Math.max(0, depDatesAll.filter((d) => d >= startDay).length - refunded);
    const depProgram = isDepositProgram(version, pps);
    const startMonth = startDay.slice(0, 7);
    const ghlBookings = bizMonths.filter((x) => x[0].slice(0, 7) >= startMonth).reduce((t, x) => t + (Number(x[2]) || 0), 0);
    /* Clients booked (for earned): the coach's "Sessions Done" count
       (Performance Tracking — sessions actually done) or the paid deposits,
       whichever is higher. With no sessions count: deposits or GHL bookings. */
    let bookedCount: number | null = null, basis: string | null = null;
    if (sessions != null) { bookedCount = Math.max(sessions, deposits); basis = sessions >= deposits ? "sessions done (coach log)" : "paid deposits"; }
    else if (depProgram || ghlBookings > 0) { bookedCount = Math.max(deposits, ghlBookings); basis = ghlBookings > deposits ? "GHL bookings (since Jul 30)" : "paid deposits"; }
    // Outside deposit funnels, without the coach's sessions count we only see
    // GHL bookings — phone/DM bookings are missing, so it's a floor.
    const partialCount = sessions == null && !depProgram && bookedCount != null;
    // A sessions count not updated in 60+ days undercounts — too low to judge on.
    const sessionsStale = sessions != null && sessions >= deposits && (!sessionsAsOf || daysSince(sessionsAsOf) > 60);
    const priceCands: Array<[unknown, string]> = [
      [r.price_offer, "offer"], [r.price_funnel, "funnel"], [r.price_v3, "V3 pricing"],
      [r.price_sheet, "Clients sheet"], [r.price_tracking, "Performance Tracking"],
    ];
    const hit = priceCands.map(([t, s]) => ({ n: parsePrice(t), s })).find((x) => x.n != null);
    const price = hit ? { amount: hit.n!, source: hit.s, typical: false } : { amount: TYPICAL_PRICE, source: "typical PMU price", typical: true };
    const earned = bookedCount == null ? null : bookedCount * price.amount;

    // ── Now ──
    const l7 = num(r.leads7) ?? 0, l30 = num(r.leads30) ?? 0;
    const d14 = num(r.dep14) ?? 0, d30 = num(r.dep30) ?? 0, dPrev = num(r.dep_prev30) ?? 0;
    const cpl7 = num(r.cpl7), cpl30 = num(r.cpl30);
    const status = (r.campaign_status as string | null) || null;
    const paused = r.campaign_paused === true;
    // No tracked campaign spend while leads come in = we can't see their ad cost.
    const adsTracked = ads > 0 || l30 === 0;
    const hotWaiting = num(r.hot_waiting) ?? 0;
    const kq = num(r.kill_qualified) ?? 0, kd = num(r.kill_dead) ?? 0;
    const killPct = kq >= 3 ? Math.round((kd / kq) * 100) : null;
    const killFixed = r.kill_fixed === true;
    const upset = num(r.upset_open) ?? 0;
    const lastTouch = (r.last_touch as string | null) ?? null;

    /* ── Leads vs goal ── budget = the live Meta daily budget (else the plan on
       the Clients sheet); no goal while ads are off. */
    const spent7 = num(r.spent7) ?? 0;
    const metaBudget = num(r.daily_budget);
    const unsettled = /unsettled/i.test(status ?? "");
    /* Leads in the last 3 days (raw sheet count) — a paused campaign still
       trickles leads for a day or two, and leads that keep coming while our
       tracked campaign is paused mean a campaign we don't track yet is on. */
    const leads3 = num(r.raw_l3) ?? l7;
    const stopped = leads3 <= 1;
    const adsOff = unsettled || ((paused || (metaBudget != null && spent7 === 0)) && stopped);
    let budget: number | null = null, budgetNote: string | null = null;
    if (adsOff) budgetNote = unsettled ? "Facebook bill unpaid — no lead goal until it's paid" : "ads off — no lead goal right now";
    // A paused campaign's budget isn't the live one: use the plan on the Clients sheet.
    else if (!paused && metaBudget != null && metaBudget > 0) budget = metaBudget;
    else { budget = parseBudget(r.ad_plan); budgetNote = budget != null ? (paused ? "tracked campaign paused — budget from the Clients sheet plan" : "budget from the Clients sheet plan") : "no daily budget found"; }
    const goal = budget != null ? Math.round(budget * LEADS_PER_DOLLAR_DAY) : null;
    // Leads per month: GHL before May 2026 (the leads sheet starts Apr 27), the sheet after.
    const sheetByMonth = new Map(bizMonths.map((x) => [x[0].slice(0, 7), x]));
    const oppByMonth = new Map(oppMonths.map((x) => [x[0].slice(0, 7), x]));
    const liveMonth = firstLead ? firstLead.slice(0, 7) : null;
    const monthLeads = (ym: string): number | null => {
      if (!liveMonth || ym < liveMonth) return null;
      const sheet = sheetByMonth.get(ym), opp = oppByMonth.get(ym);
      if (ym >= "2026-05" && sheet) return Number(sheet[1]) || 0;
      return opp ? Number(opp[1]) || 0 : sheet ? Number(sheet[1]) || 0 : 0;
    };
    const monthsSince = (from: string) => {
      const out: string[] = [];
      for (let d = new Date(`${from}-01T00:00:00Z`); d.toISOString().slice(0, 7) <= todayIso().slice(0, 7); d.setUTCMonth(d.getUTCMonth() + 1)) out.push(d.toISOString().slice(0, 7));
      return out;
    };
    const liveMonths = liveMonth ? monthsSince(liveMonth) : [];
    const leadsSinceLive = liveMonth ? liveMonths.reduce((t, ym) => t + (monthLeads(ym) ?? 0), 0) : null;
    const avgPerMonth = leadsSinceLive != null && daysLive != null && daysLive >= 14 ? leadsSinceLive / Math.max(1, daysLive / 30.44) : null;

    /* ── Bookings & booking % ── */
    // A paid deposit is a booking even when the bookings feed missed it.
    const bookings30 = Math.max(num(r.bookings30) ?? 0, depProgram ? d30 : 0);
    const pct30 = pct(bookings30, l30);
    const fromMonth = liveMonth && liveMonth > BOOKINGS_FROM_MONTH ? liveMonth : BOOKINGS_FROM_MONTH;
    const winMonths = liveMonth ? monthsSince(fromMonth) : [];
    const depsInMonth = (ym: string) => depDatesAll.filter((d) => d.slice(0, 7) === ym && d >= startDay).length;
    // On a deposit funnel a paid deposit is a booking even if the bookings feed missed it.
    const monthBookings = (ym: string) => Math.max(Number(sheetByMonth.get(ym)?.[2]) || 0, depProgram ? depsInMonth(ym) : 0);
    const bookingsSince = liveMonth ? winMonths.reduce((t, ym) => t + monthBookings(ym), 0) : null;
    const leadsSince = liveMonth ? winMonths.reduce((t, ym) => t + (monthLeads(ym) ?? 0), 0) : null;
    const coachTotal = parseSessions(r.total_leads);
    const coachPct = sessions != null && coachTotal ? sessions / coachTotal : null;
    const months = monthsSince(addDays(todayIso(), -160).slice(0, 7)).slice(-6).map((ym) => {
      const leads = monthLeads(ym);
      const bookings = ym >= BOOKINGS_FROM_MONTH && liveMonth && ym >= liveMonth ? monthBookings(ym) : null;
      // Goal for the days the client was live that month (first and current month are partial).
      const first = `${ym}-01`, dim = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
      const from = firstLead && firstLead > first ? firstLead : first;
      const to = ym === todayIso().slice(0, 7) ? todayIso() : `${ym}-${pad(dim)}`;
      const liveDays = Math.max(0, (Date.parse(to) - Date.parse(from)) / DAY + 1);
      return {
        ym, leads, bookings,
        goal: goal != null && leads != null ? Math.round(goal * Math.min(1, liveDays / dim)) : null,
        deposits: depsInMonth(ym),
        pct: bookings != null && leads ? bookings / leads : null,
        partial: ym === todayIso().slice(0, 7),
      };
    });
    /* Lead goal for the last 30 days, pro-rated while they've been live less
       than 30 days; pace = this week's leads × 30/7 (a restart or a fix shows
       here before the 30-day number catches up). */
    const expected30 = goal != null && daysLive != null ? goal * Math.min(1, daysLive / 30) : null;
    const goalRatio = expected30 ? l30 / expected30 : null;
    const paceRatio = goal ? (l7 * 30 / 7) / goal : null;

    /* The return is only shown when the inputs are whole: booking data, the
       Financing sheet loaded, and the ad spend tracked. */
    const roi = earned == null || invested <= 0 || finance.error || !adsTracked ? null : earned / invested;

    const reasons: Reason[] = [];
    const add = (key: string, light: Reason["light"], text: string, next?: string) => reasons.push({ key, light, text, next });

    // Relationship first — an upset client is the most urgent thing a coach has.
    if (upset > 0) {
      const fresh = !!r.upset_at && daysSince(String(r.upset_at)) <= 14;
      const note = String(r.upset_note ?? "").trim();
      add("upset", fresh ? "red" : "orange", `Client is upset${note ? `: ${note.length > 140 ? `${note.slice(0, 137)}…` : note}` : ""}`, "Call the client today, then tell an admin so the alert gets closed");
    }
    if (/need more bookings/i.test(payStatus ?? "")) add("pay-results", "red", "Won't pay until they get more bookings", "Fix results first (ads, AI chats, follow-up), then collect");
    else if (/^paused$/i.test(payStatus ?? "")) add("pay-paused", "orange", "Payments to us are paused", "Find out why and agree on a restart date");
    // Grace = a free month (posted in the Facebook group) or a month we covered to help — not a problem.
    else if (/^grace$/i.test(payStatus ?? "")) add("pay-grace", "info", "On a free month / being helped this month (Grace)");

    // Ads
    if (/unsettled/i.test(status ?? "")) add("ads-unsettled", "red", "Facebook bill unpaid — ads are stopped", "Ask them to approve the ad charge with their bank (button on Performance)");
    else if (/grace/i.test(status ?? "")) add("ads-grace", "orange", "Facebook bill overdue — ads stop soon", "Ask them to update their card on Facebook");
    else if (status && !/active/i.test(status)) add("ads-status", "red", `Ad account is ${status.toLowerCase().replace(/_/g, " ")}`, "Check the ad account with the media buyer");
    if (paused && stopped) add("ads-paused", "red", "Ads are paused", "Find out why and turn them back on with the media buyer");
    else if (paused) add("ads-untracked-campaign", "info", "Our tracked campaign is paused but leads still come in — a new campaign may not be tracked yet");
    else if (l7 === 0 && (age ?? 99) >= 10 && !/unsettled/i.test(status ?? "")) add("no-leads", "red", "No leads in the last 7 days", "Check the ads and the funnel with the media buyer");
    if (cpl7 != null && cpl30 != null && cpl7 >= 8 && cpl7 > cpl30 * 1.5) add("cpl-up", "orange", `Leads cost more: ${usd(cpl7)} now vs ${usd(cpl30)} over 30 days`, "Ask the media buyer for fresh ads");
    else if (cpl30 != null && cpl30 >= 20) add("cpl-high", "orange", `Expensive leads: ${usd(cpl30)} each`, "Ask the media buyer to fix targeting or ads");

    // Bookings now (deposit funnels — a deposit IS a booking)
    if (depProgram && (age ?? 0) >= 30) {
      if (d30 === 0 && l30 >= 15) add("no-deposits", "red", `No deposits in 30 days (${l30} leads came in)`, "Read the AI chats and check the deposit step");
      else if (dPrev >= 4 && d30 < dPrev / 2) add("deposits-down", "orange", `Deposits dropped: ${d30} this month vs ${dPrev} the month before`, "Check what changed — ads, price, AI chats");
    }

    // Return since day one
    if (bookedCount == null) {
      add("no-bookings-data", "orange", "We can't see their bookings", "Ask how many clients they booked from our leads and log it in Performance Tracking");
    } else if (finance.error) {
      add("no-finance", "info", "2026 payments couldn't load from the Financing sheet — return not judged");
    } else if (!adsTracked) {
      add("ads-untracked", "info", "Their ad spend isn't tracked (no matching campaigns) — return not judged");
    } else if (roi != null && sessionsStale && roi < GOOD_RETURN) {
      add("stale-sessions", "orange", `Booking count is old${sessionsAsOf ? ` (last updated ${sessionsAsOf})` : ""} — return looks ≈$${roi.toFixed(2)} per $1`, "Ask for their real booking count and update Performance Tracking");
    } else if (roi != null && partialCount && roi < GOOD_RETURN) {
      add("partial-bookings", "orange", `We only see their GHL bookings — return looks ≈$${roi.toFixed(2)} per $1`, "Ask how many clients they booked (phone/DM too) and log it in Performance Tracking");
    } else if (roi != null && comeback && roi < GOOD_RETURN && (age ?? 0) >= 30) {
      // Ad spend has no dates, so after a comeback it still includes the old stint.
      add("comeback-roi", "orange", `Came back ${comeback} — return looks ≈$${roi.toFixed(2)} per $1 (ad spend includes the earlier stint)`, "Check this stint's bookings with them");
    } else if (roi != null && age != null && age >= 60) {
      if (roi < 1) add("roi-low", "red", `Not paid back yet: ≈${usd(earned!)} earned on ${usd(invested)} invested`, "Make a plan together: price/offer, follow-up speed, booking rate");
      else if (roi < GOOD_RETURN) add("roi-thin", "orange", `Thin return: ≈$${roi.toFixed(2)} back per $1`, "Push bookings up — follow-ups, deposit step, offer");
    } else if (roi != null && age != null && age >= 30 && roi < 0.5) {
      add("slow-start", "orange", `Slow start: ≈${usd(earned!)} earned in ${age} days`, "Check follow-up and booking rate this week");
    }
    if (age != null && age < 30) add("ramping", "info", daysLive != null ? `New — live ${daysLive} days, still ramping up` : `New — day ${age}, still ramping up`);
    if (!firstLead) add("no-first-lead", "info", "No lead has come in yet");

    // Lead goal (5 a month per $1/day), pro-rated in the first month
    if (goal && expected30 && goalRatio != null && daysLive != null && daysLive >= 14) {
      const txt = `${l30} leads in 30 days vs a goal of ${Math.round(expected30)} ($${budget}/day)`;
      if (goalRatio < 0.8 && paceRatio != null && paceRatio >= 0.8) add("leads-goal", "info", `Back on pace this week (${l7} leads in 7 days) — 30-day total still below goal`);
      else if (goalRatio < 0.5) add("leads-goal", "red", `Far below lead goal: ${txt}`, "Media buyer: fix the ads/audience or lower the cost per lead");
      else if (goalRatio < 0.8) add("leads-goal", "orange", `Below lead goal: ${txt}`, "Media buyer: check the ads and the cost per lead");
    }
    /* Booking rate — V3 only: there a booking happens in GHL (calendar +
       deposit). V1/V2 clients often book by phone/DM, so GHL undercounts. */
    if (/v3/i.test(version) && l30 >= 40 && pct30 != null && pct30 < 0.03) {
      add("booking-rate", "orange", `Low booking rate: ${(pct30 * 100).toFixed(1)}% (${bookings30} bookings from ${l30} leads in 30 days)`, "Check speed to lead, follow-ups and the booking step");
    }

    // Lead care
    if (hotWaiting >= 3) add("hot-waiting", "orange", `${hotWaiting} hot leads waiting 2+ hours for a reply`, "Get them answered today");
    if (killPct != null && killPct >= 15 && !killFixed && /v3/i.test(version)) add("call-kill", "orange", `${killPct}% of leads lose the AI after a call`, "Fix the call workflow, then ask an admin to tick it on CPD");

    // Coach contact and data notes (don't change the colour)
    const touchDays = lastTouch ? daysSince(lastTouch) : null;
    if (touchDays == null || touchDays > 21) add("no-touch", "info", touchDays == null ? "No check-in note yet" : `No check-in note for ${touchDays} days`);
    if (price.typical) add("no-price", "info", `No price on file — using a typical ${usd(TYPICAL_PRICE)}`);

    /* Unknown bookings after 2+ months live: the booking-based verdicts
       (return, thin return, low booking rate…) can't be trusted, so they
       stop driving the colour and the client goes to "Unknown". Real
       problems (ads off, no leads, upset, no deposits…) still make it red. */
    // An old or partial count is a floor — if even the floor clears the bar, the return is proven.
    const bookingsUnknown = bookedCount == null || (bookedCount === 0 && sessions == null)
      || ((sessionsStale || partialCount) && (roi == null || roi < GOOD_RETURN));
    const unknownBucket = bookingsUnknown && (age ?? 0) >= 60;
    if (unknownBucket) {
      const BOOKING_BASED = new Set(["roi-low", "roi-thin", "stale-sessions", "partial-bookings", "comeback-roi", "slow-start", "booking-rate"]);
      for (let i = reasons.length - 1; i >= 0; i--) {
        if (reasons[i].key === "no-bookings-data") reasons.splice(i, 1);
        else if (BOOKING_BASED.has(reasons[i].key)) reasons[i] = { ...reasons[i], light: "info", next: undefined };
      }
      add("bookings-unknown", "unknown",
        sessions != null && sessionsAsOf ? `We don't know their bookings — the count was last updated ${sessionsAsOf}` : "We don't know how many clients they've booked — leads may not be moved to the booked stage",
        "Ask how many they booked, and make sure booked leads are moved to the right stage in GHL (or logged in Performance Tracking)");
    }

    // Red reasons first, then orange, unknown, then notes. A real (non-booking)
    // orange problem keeps the client in Orange — the ⚪ line still shows.
    const order = { red: 0, orange: 1, unknown: 2, green: 3, info: 4 } as const;
    reasons.sort((a, b) => order[a.light] - order[b.light]);
    const light: Light = reasons.some((x) => x.light === "red") ? "red"
      : reasons.some((x) => x.light === "orange") ? "orange"
      : unknownBucket ? "unknown" : "green";

    return {
      ownerKey,
      owner: String(r.owner_name ?? ""),
      business: String(r.business_name ?? ""),
      coach: String(r.assigned ?? ""),
      version,
      light,
      reasons,
      start: { date: start?.d ?? null, source: start?.s ?? "unknown", days, cameBack: !!comeback },
      live: { firstLead, days: daysLive, note: liveNote },
      leads: { last7: l7, last30: l30, budget, budgetNote, goal, expected30: expected30 != null ? Math.round(expected30) : null, ratio: daysLive != null && daysLive >= 14 ? goalRatio : null, sinceLive: leadsSinceLive, avgPerMonth },
      bookings: {
        last30: bookings30, pct30, since: bookingsSince, leadsSince, pctSince: bookingsSince != null && leadsSince ? bookingsSince / leadsSince : null,
        sinceLabel: liveMonth ? (fromMonth === liveMonth ? "since going live" : "since Aug 1") : null,
        coachPct, coachAsOf: sessionsAsOf,
        ...(depProgram
          ? { rowPct: pct30, rowSource: "GHL bookings + paid deposits, last 30 days" }
          : coachPct != null
            ? { rowPct: coachPct, rowSource: `coach log (sessions ÷ leads)${sessionsAsOf ? `, as of ${sessionsAsOf}` : ""}` }
            : bookings30 > 0
              ? { rowPct: pct30, rowSource: "GHL bookings only, last 30 days (phone/DM bookings not counted)" }
              : { rowPct: null, rowSource: "no booking data — phone/DM bookings aren't tracked" }),
      },
      months,
      invested: { total: invested, feesBefore2026, fees2026: f26, ads, depositsKept },
      booked: { count: bookedCount, basis, sessions, sessionsAsOf, deposits, ghlBookings, refunded },
      price,
      earned,
      roi,
      recent: { deposits14: d14, deposits30: d30, depositsPrev30: dPrev, cpl7, cpl30 },
      ads: { status, paused, dailyBudget: num(r.daily_budget), tracked: adsTracked },
      care: { hotWaiting, killPct, killFixed, upset },
      pay: { status: payStatus, thisMonth: num(r.pay_this_month), pps },
      lastTouch,
    };
  });

  const rank: Record<Light, number> = { red: 0, orange: 1, unknown: 2, green: 3 };
  clients.sort((a, b) => rank[a.light] - rank[b.light] || (a.roi ?? -1) - (b.roi ?? -1) || a.owner.localeCompare(b.owner));
  return { clients, financeError: finance.error, unmatchedPayers };
}
