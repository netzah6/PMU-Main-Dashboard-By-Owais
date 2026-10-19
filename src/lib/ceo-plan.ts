import { createServiceClient } from "@/lib/supabase/server";
import { getRoadWithFinance, PROFIT_GOAL, TARGETS, nk, sameClient, coverageOf, demoMonth, type SquarePlans } from "@/lib/ceo-growth";
import type { FinanceRow, MonthFinance } from "@/lib/ceo-finance";

/* "A plan every month so I know exactly what I need to do" (owner,
   2026-10-04). Built fresh from the data each time it opens — never typed by
   hand — so it is always this month's real list:
     • this month's profit goal: a straight line from last month's profit to
       $100k by GOAL_MONTH
     • one section per lever, each with a target, where last month landed,
       where this month stands so far, and the exact to-dos WITH NAMES (who
       needs bookings, who to win back, whose call workflow to fix, who closed)
   Ticks are saved per month (ceo_plan_done), so next month starts clean.
   Owner, 2026-10-19: the "no retainer under $500" section is gone for good —
   long-time clients keep their price. Three sections now. */

export const GOAL_MONTH = "2027-03";

/* Deposits goal ladder (owner, 2026-10-19: September was ~$12.8k, October
   is heading for ~$17–18k — "it's better to always set up a higher goal so
   we can achieve the results fast": $20k, then +$4,000 a month). */
export const DEPOSIT_GOALS: Record<string, number> = {
  "2026-10": 20_000, "2026-11": 24_000, "2026-12": 28_000, "2027-01": 32_000, "2027-02": 36_000, "2027-03": 40_000,
};
export const depositGoal = (ym: string): number | null =>
  DEPOSIT_GOALS[ym] ?? (ym > "2027-03" ? 40_000 + 4_000 * monthsBetween("2027-03", ym) : null);
/* New-client cash goal next to the client count (owner, 2026-10-19: "an
   amount goal in addition to the number of clients"). 16 closes at the
   ~$1,900 the 3- and 7-month plans bring = $30k; July did $26.5k from 20. */
export const NEW_CASH_GOAL = 30_000;

export type PlanItem = {
  key: string; text: string; detail?: string; done: { by: string | null; at: string } | null;
  /** Informational line (a close, a summary) — shown without a checkbox. */
  info?: boolean;
};
export type PlanSection = {
  key: string; title: string; why: string; target: string; last: string; ok: boolean | null; items: PlanItem[];
  /** Where this month stands so far ("October so far: 3 to chase · …"). */
  now?: string;
};
export type MonthPlan = {
  ym: string; label: string; goalMonth: string;
  profitGoal: number | null; lastLabel: string; lastProfit: number | null;
  sections: PlanSection[];
};

const monthsBetween = (a: string, b: string) => {
  const [ay, am] = a.split("-").map(Number), [by, bm] = b.split("-").map(Number);
  return (by - ay) * 12 + (bm - am);
};
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "2026-10" → "October"; "2026-10-03" → "Oct 3" (US month-first). */
const monthName = (ym: string) => MONTH_LONG[Number(ym.slice(5, 7)) - 1] ?? ym;
const shortDate = (ymd: string) => `${MONTH_SHORT[Number(ymd.slice(5, 7)) - 1]} ${Number(ymd.slice(8, 10))}`;

/* The month a free-text day-of-payment cell points at ("Jan 14th 2027",
   "Dec?", "Nov 1st", "October?") → "YYYY-MM". A month with no year is the
   next one coming: "Jan?" written in October means January next year. Null
   for day numbers ("15"), "HOLD", "Didn't start yet" or blanks. */
function cellMonth(raw: string, curYm: string): string | null {
  const m = raw.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i);
  if (!m) return null;
  const mi = MONTH_SHORT.findIndex((s) => s.toLowerCase() === m[1].toLowerCase()) + 1;
  const y = raw.match(/\b(20\d\d)\b/);
  const year = y ? Number(y[1]) : Number(curYm.slice(0, 4)) + (mi >= Number(curYm.slice(5, 7)) ? 0 : 1);
  return `${year}-${String(mi).padStart(2, "0")}`;
}
/** "02/10/2026" (the Demos sheet is DD/MM/YYYY) → "2026-10-02". */
function ddmmyyyy(raw: unknown): string | null {
  const m = String(raw ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
}
const sum = (xs: number[]) => xs.reduce((t, x) => t + x, 0);

/* Deposits (the Fanbasis / Whop lead deposits, table `deposits`) summed per
   month: "Date" is DD/MM/YYYY (a few old rows are ISO), "Amount" is "$50",
   "Business Name" has stray tabs / spaces ("BeyondBrowz\t", "Naples Beauty "). */
type DepositMonth = { total: number; count: number; clients: number };
async function depositsByMonth(svc: ReturnType<typeof createServiceClient>, yms: string[]): Promise<Map<string, DepositMonth>> {
  const acc = new Map<string, { total: number; count: number; biz: Set<string> }>();
  for (const ym of yms) acc.set(ym, { total: 0, count: 0, biz: new Set() });
  const normBiz = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  for (let off = 0; ; off += 1000) {
    const { data } = await svc.from("deposits").select("data").range(off, off + 999);
    for (const r of (data ?? []) as Array<{ data: Record<string, unknown> }>) {
      const raw = String(r.data?.["Date"] ?? "");
      const ym = ddmmyyyy(raw)?.slice(0, 7) ?? (/^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 7) : null);
      const slot = ym ? acc.get(ym) : undefined;
      if (!slot) continue;
      const amt = Number(String(r.data?.["Amount"] ?? "").replace(/[^0-9.-]/g, ""));
      if (!(amt > 0)) continue;
      slot.total += amt; slot.count++; slot.biz.add(normBiz(r.data?.["Business Name"]));
    }
    if (!data || data.length < 1000) break;
  }
  return new Map([...acc.entries()].map(([ym, v]) => [ym, { total: Math.round(v.total), count: v.count, clients: v.biz.size }]));
}

type CmRow = Record<string, unknown>;
type DepRow = { name: string; status: string; coach: string; spent30: number; d30: number; l30: number };

export async function buildMonthPlan(): Promise<MonthPlan | { error: string }> {
  const { road, finance, plans, coverage, demoRows } = await getRoadWithFinance();
  if (road.error || !road.months.length) return { error: road.error ?? "no finance data" };
  const svc = createServiceClient();
  // The plan is for the CALENDAR month (even before its Financing tab
  // exists); "last" = the latest finished month that has a profit figure.
  const now = new Date();
  const curYm = now.toISOString().slice(0, 7);
  const curLabel = monthName(curYm);
  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const daysLeft = daysInMonth - dayOfMonth;
  const last = [...road.months].reverse().find((m) => m.ym < curYm && m.profit != null)
    ?? [...road.months].reverse().find((m) => m.ym < curYm) ?? road.months[road.months.length - 1];
  const curRoad = road.months.find((m) => m.ym === curYm);
  const curFin = finance.find((m) => m.ym === curYm);
  const lastFin = finance.find((m) => m.ym === last.ym);

  // Profit goal for THIS month on a straight line to $100k by GOAL_MONTH.
  const steps = Math.max(1, monthsBetween(last.ym, GOAL_MONTH));
  const profitGoal = last.profit == null ? null : Math.min(PROFIT_GOAL,
    Math.round((last.profit + ((PROFIT_GOAL - last.profit) / steps) * Math.max(1, monthsBetween(last.ym, curYm))) / 500) * 500);

  const [{ data: doneRows }, cmRows, { data: killRows }, { data: fixRows }, ppaOwners, deps, liveSeen, depMonths, campaignNames] = await Promise.all([
    svc.from("ceo_plan_done").select("item_key, done_by, done_at").eq("ym", curYm),
    (async () => {
      const out: CmRow[] = [];
      for (let off = 0; ; off += 1000) {
        const { data } = await svc.from("clients_master").select("data").range(off, off + 999);
        for (const r of (data ?? []) as Array<{ data: CmRow }>) out.push(r.data);
        if (!data || data.length < 1000) break;
      }
      return out;
    })(),
    svc.from("call_kill_stats").select("owner_key, qualified, dead"),
    svc.from("call_kill_fixes").select("owner_key").eq("fixed", true),
    (async () => {
      // Pay-per-appointment clients = the ones Square bills per show.
      const s = new Set<string>();
      for (let off = 0; ; off += 1000) {
        const { data } = await svc.from("ppa_charges").select("owner_key").eq("charged", true).range(off, off + 999);
        for (const r of (data ?? []) as Array<{ owner_key: string | null }>) if (r.owner_key) s.add(r.owner_key);
        if (!data || data.length < 1000) break;
      }
      return [...s];
    })(),
    // Ads + deposits in the last 30 days per client — the same numbers as the CPD tab.
    svc.from("deposit_overview").select("owner_name, client_status, assigned, spent30, d30, l30").then(({ data }) =>
      ((data ?? []) as Array<Record<string, unknown>>).map((r): DepRow => ({
        name: String(r.owner_name ?? "").trim(), status: String(r.client_status ?? "").trim(), coach: String(r.assigned ?? "").trim(),
        spent30: Number(r.spent30 ?? 0), d30: Number(r.d30 ?? 0), l30: Number(r.l30 ?? 0),
      }))),
    // Who turned Live this month (first seen Live by the agreement check, not a baseline seed).
    svc.from("client_live_seen").select("owner_name, baseline, first_seen_live_at").eq("baseline", false).gte("first_seen_live_at", `${curYm}-01`)
      .then(({ data }) => ((data ?? []) as Array<{ owner_name: string | null }>).map((r) => String(r.owner_name ?? "")).filter(Boolean)),
    depositsByMonth(svc, [last.ym, curYm]),
    // Former clients already in the win-back campaign (AI tab) — the plan
    // points at the campaign instead of repeating them as to-dos.
    svc.from("winback_contacts").select("owner_name").eq("active", true).range(0, 999)
      .then(({ data }) => ((data ?? []) as Array<{ owner_name: string | null }>).map((r) => String(r.owner_name ?? "")).filter(Boolean)),
  ]);
  const done = new Map(((doneRows ?? []) as Array<{ item_key: string; done_by: string | null; done_at: string }>).map((r) => [r.item_key, { by: r.done_by, at: r.done_at }]));
  /* section + action + person: one person can have two different to-dos.
     `keyText` pins the key when the visible text carries a moving number
     ("Close 9 more…" changes daily) so an earlier tick survives. */
  const item = (section: string, who: string, text: string, detail?: string, opts?: { keyText?: string; info?: boolean }): PlanItem => {
    const key = `${section}:${nk((opts?.keyText ?? text).split(" ").slice(0, 2).join(" "))}:${nk(who) || nk(text)}`;
    return { key, text, detail, done: done.get(key) ?? null, ...(opts?.info ? { info: true } : {}) };
  };

  const liveName = (d: CmRow) => String(d["Owner Full Name"] ?? "").trim();
  const cmStatus = (d: CmRow | undefined) => String(d?.["col_1"] ?? "").trim();
  const cmOf = (name: string) => cmRows.find((d) => sameClient(liveName(d), name));
  const live = cmRows.filter((d) => /^live$/i.test(cmStatus(d)));
  const inList = (list: string[], name: string) => list.some((n) => sameClient(n, name));
  // Pay-per-show: Square bills them per show, or the Financing sheet says so
  // ("$50 deposit + $45 per show") — a PPS client with no shows paid $0, not left.
  const ppsSheet = [...(lastFin?.ppsNames ?? []), ...(curFin?.ppsNames ?? [])];
  const isPps = (name: string) => inList(ppaOwners, name) || inList(ppsSheet, name);
  const depositOnly = (name: string) => inList([...(lastFin?.depositOnlyNames ?? []), ...(curFin?.depositOnlyNames ?? [])], name);
  const onSquare = (list: SquarePlans["active"], name: string, cm: CmRow | undefined) => {
    const email = String(cm?.["Email"] ?? "").trim().toLowerCase();
    return list.some((p) => (!!email && p.email === email) || sameClient(p.name, name));
  };
  const rowsOf = (m: MonthFinance | undefined, name: string): FinanceRow[] => (m?.rows ?? []).filter((r) => sameClient(r.name, name));
  /** The client's latest payment on the sheet (any month up to this one). */
  const lastPayment = (name: string): { amount: number; label: string; ym: string } | null => {
    for (const m of [...finance].reverse()) {
      if (m.ym > curYm) continue;
      const p = m.payers.find((x) => sameClient(x.name, name));
      if (p) return { amount: p.amount, label: m.label, ym: m.ym };
    }
    return null;
  };

  /* ── 1 · Keep every client ───────────────────────────────────────────────
     Built from THIS month's Financing tab (the owner keeps its statuses
     current — owner, 2026-10-19) with last month as the second signal. A
     client is FINE and never listed when any of: paid this month; marked
     Paid / Paid Upfront / PPS / Grace; covered by a prepaid plan note; on an
     active or prepaid Square plan; pay-per-show; went Live this month or is a
     first-time payer; Offboarded on the Clients sheet. */
  type Cand = { name: string; cm: CmRow | undefined };
  const cands: Cand[] = [];
  const addCand = (name: string) => {
    if (!name || cands.some((c) => sameClient(c.name, name))) return;
    cands.push({ name, cm: cmOf(name) });
  };
  for (const r of curFin?.rows ?? []) addCand(r.name);
  for (const r of lastFin?.rows ?? []) addCand(r.name);
  for (const d of cmRows) if (/^(live|paused)$/i.test(cmStatus(d))) addCand(liveName(d));

  const graceNow = curFin?.graceNames ?? [];
  const upfrontNow = (curFin?.upfrontNames ?? []).filter((n, i, a) => a.findIndex((x) => sameClient(x, n)) === i);
  const needBookings: PlanItem[] = [], winBack: PlanItem[] = [], collect: PlanItem[] = [], restart: PlanItem[] = [];
  const inCampaign: string[] = []; // recent leavers the win-back campaign is already texting
  const todayDay = dayOfMonth;
  const dayWord = (d: number) => `${MONTH_SHORT[Number(curYm.slice(5, 7)) - 1]} ${d}`;
  for (const c of cands) {
    const rowsCur = rowsOf(curFin, c.name), rowsLast = rowsOf(lastFin, c.name);
    const amtCur = sum(rowsCur.map((r) => r.amount)), amtLast = sum(rowsLast.map((r) => r.amount));
    const stCur = rowsCur.map((r) => r.status.toLowerCase()).filter(Boolean);
    const status = cmStatus(c.cm);
    const cov = coverageOf(coverage, c.name);
    const coveredNow = !!cov && cov.end >= curYm;
    const fine = amtCur > 0
      || stCur.some((s) => /^(paid|paid upfront|pps|grace)$/.test(s))
      || coveredNow
      || onSquare(plans.active, c.name, c.cm)
      || isPps(c.name)
      || inList(liveSeen, c.name)
      || inList(curFin?.firstTimePayers ?? [], c.name)
      || /^offboarded$/i.test(status)
      || depositOnly(c.name);
    if (fine) continue;
    // Shown by the name the dashboard uses (the Clients sheet) — Financing
    // writes "Oyunchimeg Erdenetsogt (Jessica Lee)" for Jessica Lee.
    const who = c.cm ? liveName(c.cm) : c.name;
    const paid = lastPayment(c.name);
    const paidLine = paid ? `Last paid ${usd(paid.amount)} in ${paid.label}` : "No payment on the Financing sheet";
    // Paid within the last three months — a pause from January isn't this
    // month's leak (those former clients get the win-back campaign instead).
    const recent = !!paid && monthsBetween(paid.ym, curYm) <= 3;
    const noCard = rowsCur.some((r) => /no card/i.test(r.billing)) ? " · No card on file" : "";
    const onClients = /^(live|paused)$/i.test(status) ? ` · ${status} on the Clients sheet` : "";
    // From here on nothing was paid this month (that was the first FINE test).
    if (stCur.some((s) => /need more bookings/.test(s))) {
      needBookings.push(item("keep", who, `Needs bookings before they pay again — ${who}`, `${paidLine} · marked "Need More Bookings" on the Financing sheet${noCard}${onClients}`));
      continue;
    }
    const pausedOnSheet = stCur.some((s) => s === "paused");
    if (pausedOnSheet || amtLast === 0) {
      // Win back: only while the Clients sheet still has them as Live / Paused
      // (already-offboarded ones were left on purpose), and only a recent
      // stop — or a Live client with no payment row at all, which is a check.
      if (!/^(live|paused)$/i.test(status)) continue;
      if (!recent && !(!pausedOnSheet && /^live$/i.test(status))) continue;
      const why = pausedOnSheet ? "Paused on the Financing sheet" : `Nothing in ${last.label} or ${curLabel}`;
      if (inList(campaignNames, c.name) || (c.cm && inList(campaignNames, who))) { inCampaign.push(who); continue; }
      winBack.push(item("keep", who, `Win back ${who}`, `${why} · ${paidLine}${noCard}${onClients}`));
      continue;
    }
    // Paid last month, nothing yet this month. Due day: this month's row,
    // else last month's. Not due yet (or due in the last 2 days) → not listed.
    const due = rowsCur.map((r) => r.day).find((d) => d != null) ?? rowsLast.map((r) => r.day).find((d) => d != null) ?? null;
    const pendingPast = stCur.some((s) => s === "pending") && due != null && due < todayDay;
    if (due != null && (due <= todayDay - 3 || pendingPast)) {
      collect.push(item("keep", who, `Collect from ${who}`, `Paid ${usd(amtLast)} in ${last.label}, nothing yet in ${curLabel} · due ${dayWord(due)}${noCard}${onClients}`));
      continue;
    }
    if (/^live$/i.test(status) && onSquare(plans.paused, c.name, c.cm)) {
      restart.push(item("keep", who, `Restart or offboard ${who}`, `Square plan paused, nothing paid in ${curLabel}, still Live on the Clients sheet · ${paidLine}${noCard}`));
    }
  }
  /* Prepaid period looks over: a $0 "Paid Upfront" row is covered this month
     (owner, 2026-10-19), but when the plan note's month count ran out before
     this month — or the owner's own next-payment cell names a past month — it
     gets a soft "check" line, never "restart or offboard". */
  const prepaidOver: PlanItem[] = [];
  for (const name of upfrontNow) {
    const row = rowsOf(curFin, name).find((r) => /paid\s*upfront/i.test(r.status) && !(r.amount > 0));
    if (!row || /didn.?t start|hold/i.test(row.dayRaw)) continue;
    const cm = cmOf(name);
    if (onSquare(plans.active, name, cm)) continue;
    const cellYm = cellMonth(row.dayRaw, curYm);
    const cov = coverageOf(coverage, name);
    let why = "";
    if (cellYm) { if (cellYm < curYm) why = `next payment noted "${row.dayRaw}" on the Financing sheet`; }
    else if (cov && cov.end < curYm) why = `${cov.months} months from ${cov.label} (${usd(cov.amount)}) ran out in ${monthName(cov.end)}`;
    const who = cm ? liveName(cm) : name;
    if (why) prepaidOver.push(item("keep", who, `Prepaid period looks over — check ${who}`, `"${row.note}" · ${why}`));
  }
  const campaignLine = inCampaign.length
    ? [item("keep", "win-back-campaign", `${inCampaign.length} recent leaver${inCampaign.length === 1 ? " is" : "s are"} in the win-back campaign (AI tab → Win-back)`, inCampaign.join(", "), { keyText: "in campaign", info: true })]
    : [];
  const keepItems: PlanItem[] = [...needBookings, ...winBack, ...collect, ...restart, ...prepaidOver, ...campaignLine];
  const toChase = needBookings.length + winBack.length + collect.length + restart.length;

  /* ── 2 · Grow deposits ──────────────────────────────────────────────── */
  const killFixed = new Set(((fixRows ?? []) as Array<{ owner_key: string }>).map((r) => r.owner_key));
  const killItems = ((killRows ?? []) as Array<{ owner_key: string; qualified: number; dead: number }>)
    // The red ones on the CPD tab (15%+) — the orange ones can wait.
    .filter((k) => k.qualified >= 3 && k.dead / k.qualified >= 0.15 && !killFixed.has(String(k.owner_key).toLowerCase().trim()))
    .sort((a, b) => b.dead / b.qualified - a.dead / a.qualified)
    // Only Live V3 accounts — V1/V2.3 have no AI to lose, and the CPD tab
    // only shows (and lets you tick) Kill % for V3.
    .map((k) => ({ k, d: live.find((x) => sameClient(liveName(x), k.owner_key) && /v3/i.test(String(x["Version"] ?? ""))) }))
    .filter((x) => !!x.d)
    .map(({ k, d }) => {
      const name = liveName(d!);
      return item("pps", name, `Fix the call workflow for ${name}`, `${Math.round((k.dead / k.qualified) * 100)}% of leads lose the AI after a call — tick it on the CPD tab too`);
    });
  const liveDeps = deps.filter((r) => /^live$/i.test(r.status) && r.name);
  const coachOf = (r: DepRow) => (r.coach ? `coach ${r.coach}` : "no coach");
  // (i) Ads running, nothing to show: the biggest spenders first, top 10.
  const adsNoDeps = liveDeps.filter((r) => r.spent30 > 0 && r.d30 === 0).sort((a, b) => b.spent30 - a.spent30);
  const adsOnItems = adsNoDeps.slice(0, 10).map((r) =>
    item("pps", r.name, `Ads on but no deposits in 30 days — ${r.name}`, `${usd(r.spent30)} spent, ${r.l30} leads, ${coachOf(r)}`));
  if (adsNoDeps.length > 10) adsOnItems.push(item("pps", "ads-on-more", `…and ${adsNoDeps.length - 10} more with ads on and zero deposits`, adsNoDeps.slice(10).map((r) => r.name).join(", "), { keyText: "ads on more", info: true }));
  // (ii) Ads off and no deposits either.
  const adsOff = liveDeps.filter((r) => r.spent30 === 0 && r.d30 === 0);
  const adsOffItems = adsOff.map((r) =>
    item("pps", r.name, `Ads are off — ${r.name}`, `0 deposits in 30 days, ${coachOf(r)}`));
  // (iii) Pay-per-appointment clients with no deposits — unless already listed above.
  // "Above" includes the names folded into the "…and N more" line (they live in
  // its detail, not its text), so nobody shows up twice in this section.
  const alreadyListed = [...adsNoDeps, ...adsOff].map((r) => r.name);
  const listed = (name: string) => alreadyListed.some((n) => sameClient(n, name));
  const ppsNoDeposits = live
    .filter((d) => isPps(liveName(d)) && !listed(liveName(d)))
    .filter((d) => { const r = deps.find((x) => sameClient(x.name, liveName(d))); return !!r && r.d30 === 0; })
    .map((d) => item("pps", liveName(d), `Get ${liveName(d)} deposits again`, "Pay-per-appointment, 0 deposits in the last 30 days — check ads and funnel"));
  const ppsItems = [...killItems, ...adsOnItems, ...adsOffItems, ...ppsNoDeposits];
  const depLast = depMonths.get(last.ym) ?? { total: 0, count: 0, clients: 0 };
  const depNow = depMonths.get(curYm) ?? { total: 0, count: 0, clients: 0 };
  const goal = depositGoal(curYm) ?? 0;
  const lastGoal = depositGoal(last.ym);
  const pace = dayOfMonth ? Math.round((depNow.total / dayOfMonth) * daysInMonth / 100) * 100 : 0;
  const feesNow = curRoad?.ppsFees ?? 0;

  /* ── 3 · Sign more clients ──────────────────────────────────────────────
     Closed so far = first-time payers on THIS month's tab that are retainer
     rows (a PPS first-timer is an existing client who switched to pay-per-
     show, not a close; a hold deposit is a prospect), with the closer and
     close date from the Demos sheet when a row matches. */
  const bestDemo = (name: string): Record<string, unknown> | null => {
    const score = (r: Record<string, unknown>) => {
      const closeYm = ddmmyyyy(r["Close Date"])?.slice(0, 7);
      return (/^closed$/i.test(String(r["Status"] ?? "")) ? 4 : 0) + (closeYm === curYm ? 2 : closeYm ? 1 : 0) + (demoMonth(r["Demo Date"]) === curYm ? 1 : 0);
    };
    return demoRows.filter((r) => sameClient(String(r["Full Name"] ?? ""), name)).sort((a, b) => score(b) - score(a))[0] ?? null;
  };
  const closesOf = (m: MonthFinance | undefined) => (m?.firstTimePayers ?? [])
    .filter((n) => !isPps(n) && !depositOnly(n) && !(m?.payers.find((p) => sameClient(p.name, n))?.pps));
  const lastNewCash = sum(closesOf(lastFin).map((n) => lastFin?.payers.find((p) => sameClient(p.name, n))?.amount ?? 0));
  const closes = closesOf(curFin)
    .map((n) => {
      const payer = curFin?.payers.find((p) => sameClient(p.name, n));
      const demo = bestDemo(n);
      const closeDate = ddmmyyyy(demo?.["Close Date"]);
      const when = closeDate?.startsWith(curYm) ? shortDate(closeDate) : payer?.day ? dayWord(payer.day) : "";
      return { name: n, amount: payer?.amount ?? 0, closer: String(demo?.["Assigned Person"] ?? "").trim(), when };
    });
  const upfrontTotal = sum(closes.map((c) => c.amount));
  const cashLeft = Math.max(0, NEW_CASH_GOAL - upfrontTotal);
  const closesLeft = Math.max(0, TARGETS.closesMin - closes.length);
  const perWeek = Math.ceil(closesLeft / Math.max(1, daysLeft / 7));
  const closeRate = last.demosShowed ? last.demosClosed / last.demosShowed : 0.4;
  const showRate = 1 - TARGETS.noShowMaxPct / 100;
  const demosNeeded = Math.ceil(TARGETS.closesMin / Math.max(0.2, closeRate) / showRate);
  const nowDemos = curRoad ? `${curRoad.demosBooked} booked so far in ${curLabel}` : `no demos yet in ${curLabel}`;
  const nowMissed = curRoad?.noShowPct != null ? `${curRoad.noShowPct}% missed so far in ${curLabel}` : `none missed yet in ${curLabel}`;
  const salesItems: PlanItem[] = [
    ...closes.map((c) => item("sales", c.name, `Closed: ${c.name} — ${usd(c.amount)}${c.closer ? ` · ${c.closer}` : ""}${c.when ? ` · ${c.when}` : ""}`, undefined, { keyText: "closed", info: true })),
    item("sales", "close", closesLeft ? `Close ${closesLeft} more by ${dayWord(daysInMonth)} (≈ ${perWeek} a week)` : `Close more than ${TARGETS.closesMin} this month — target hit`,
      `${closes.length} of ${TARGETS.closesMin} closed so far in ${curLabel} · ${usd(upfrontTotal)} of ${usd(NEW_CASH_GOAL)} upfront${cashLeft ? ` (${usd(cashLeft)} to go)` : " — cash goal hit"} · ${last.demosClosed} closed in ${last.label}`, { keyText: "Close 16+ new clients" }),
    item("sales", "confirm", `Confirm every demo the day before and 2 hours before`, `${last.noShowPct ?? "—"}% missed in ${last.label} · ${nowMissed} — goal ${TARGETS.noShowMaxPct}% or less`),
    item("sales", "book", `Book ${demosNeeded}+ demo calls this month`, `${last.demosBooked} booked in ${last.label} · ${nowDemos}; at ${Math.round(closeRate * 100)}% close that gives ${TARGETS.closesMin} clients`),
  ];

  return {
    ym: curYm, label: curLabel, goalMonth: GOAL_MONTH,
    profitGoal, lastLabel: last.label, lastProfit: last.profit,
    sections: [
      {
        key: "keep", title: "1 · Keep every client",
        why: `Clients who stop paying are the biggest leak. Paid, prepaid, pay-per-show and Grace clients (free month / being helped) are never listed — only the ones with something to do.`,
        target: `${TARGETS.lostMax} or fewer stop paying`, last: `${last.lostClients ?? "—"} stopped in ${last.label}`,
        now: `${curLabel} so far: ${toChase} to chase · ${graceNow.length} on Grace · ${upfrontNow.length} prepaid`,
        ok: last.lostClients != null ? last.lostClients <= TARGETS.lostMax : null, items: keepItems,
      },
      {
        key: "pps", title: "2 · Grow deposits",
        why: "More lead deposits = more money we keep + happier clients. Ads that run without a deposit, or that are switched off, are where deposits are lost.",
        target: `${usd(goal)} in deposits this month`, last: `${usd(depLast.total)} in ${last.label} (${depLast.count} deposits, ${depLast.clients} clients · + ${usd(last.ppsFees)} per-show fees)`,
        now: `${usd(depNow.total)} so far (${depNow.count} deposits, ${depNow.clients} clients) · on pace for ~${usd(pace)} · goal ${usd(goal)} · ${daysLeft} days left${feesNow ? ` · + ${usd(feesNow)} per-show fees` : ""}`,
        ok: lastGoal != null ? depLast.total >= lastGoal : null, items: ppsItems,
      },
      {
        key: "sales", title: "3 · Sign more clients", why: "Fewer missed calls and more demos = more new clients.",
        target: `${TARGETS.closesMin}+ new clients and ${usd(NEW_CASH_GOAL)}+ upfront, ≤${TARGETS.noShowMaxPct}% missed`,
        last: `${closesOf(lastFin).length} closed (${usd(lastNewCash)} upfront), ${last.noShowPct ?? "—"}% missed in ${last.label}`,
        now: `${curLabel} so far: ${closes.length} of ${TARGETS.closesMin} closed · ${usd(upfrontTotal)} of ${usd(NEW_CASH_GOAL)} upfront · ${nowDemos}${curRoad?.noShowPct != null ? `, ${curRoad.noShowPct}% missed` : ""}`,
        ok: closesOf(lastFin).length >= TARGETS.closesMin && lastNewCash >= NEW_CASH_GOAL && (last.noShowPct ?? 100) <= TARGETS.noShowMaxPct, items: salesItems,
      },
    ],
  };
}
