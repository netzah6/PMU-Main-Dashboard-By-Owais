import { createServiceClient } from "@/lib/supabase/server";
import { getAgencyFinance, type MonthFinance } from "@/lib/ceo-finance";
import { readSquareSnapshot } from "@/lib/square-snapshot";

/* "Road to $100k/mo profit" (owner, 2026-10-03). One row per month with the
   four levers that close the gap from ~$60k:
     1. churn          — clients lost (paid last month, not this month)
     2. PPS money      — lead deposits kept + per-show fees (pay-per-appointment)
     3. price floor    — clients paying under $500 / month
     4. sales          — demos booked → showed → closed, and ad $ per close
   Sources: the Financing workbook (profit, payers, deposits, FB ads),
   ppa_charges (per-show fees), sales_demos (the Demos sheet mirror). */

export const PROFIT_GOAL = 100_000;
export const TARGETS = { lostMax: 12, ppsMin: 32_000, under500Max: 0, noShowMaxPct: 15, closesMin: 16 } as const;

export type GrowthMonth = {
  ym: string; label: string; partial: boolean;
  profit: number | null; income: number | null; expense: number | null;
  payingClients: number; newClients: number; lostClients: number | null;
  under500: number; avgPerClient: number | null;
  ppsDeposits: number; ppsFees: number; ppsIncome: number;
  /** Per-show fees Square actually charged that month (cross-check for ppsFees). */
  ppsFeesSquare: number;
  ppsClients: number;
  newList: string[]; lostList: string[];
  under500List: Array<{ name: string; amount: number }>;
  /** Live on Clients Master today but no payment row this month (name-matched). */
  liveNotPaying: Array<{ name: string; business: string; version: string }> | null;
  /** On a free month / helped this month ("Grace" on the sheet) — not churn. */
  graceList: string[];
  /** Pay-per-show rows that month ($0 ones too — no shows yet). */
  ppsList: string[];
  /** Clients on a prepaid Square plan (quarterly / 6-month / yearly) — paying, no monthly row. */
  prepaidCount: number;
  demosBooked: number; demosShowed: number; demosClosed: number; noShowPct: number | null;
  adSpend: number | null; adPerClose: number | null;
};

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export const nk = (s: unknown) => String(s ?? "").toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

/* The ways one name can be written across the sheets (owner, 2026-10-19:
   "Annie Luong (Xuan)" on the Clients sheet is "Xuan Luong" on Financing;
   "Oyunchimeg Erdenetsogt (Jessica Lee)" is "Jessica Lee" everywhere else):
     • the name without its parentheses        "annie luong"
     • each parenthetical alias on its own      "xuan"   (strict: exact match only)
     • the alias with the base's last word      "xuan luong"
     • each side of a "Martin Aba / Alise Herrera" partner row
   A one-word alias is "strict" so "(Robert)" can't swallow every Roberta. */
type NameVariant = { s: string; strict: boolean };
/* Names the Financing sheet writes in a way no rule can connect (found
   2026-10-19: "Lei" = Leicrina'ony Blanco of Love•Lei Aesthetics, a $0 Paid
   Upfront row that read as "no payment" and put her on the win-back list).
   Key and value are nk() forms. Add a line here when a payer only matches by
   hand — never widen the fuzzy rules for one person. */
const KNOWN_ALIASES: Record<string, string> = {
  "lei": "leicrina ony blanco",
};
const variantCache = new Map<string, NameVariant[]>();
export function nameVariants(raw: unknown): NameVariant[] {
  const src = String(raw ?? "");
  const hit = variantCache.get(src);
  if (hit) return hit;
  const seen = new Set<string>();
  const out: NameVariant[] = [];
  const add = (s: string, strict = false) => { if (s && !seen.has(s)) { seen.add(s); out.push({ s, strict }); } };
  const base = nk(src);
  add(base);
  if (KNOWN_ALIASES[base]) add(KNOWN_ALIASES[base]);
  const last = base.split(" ").filter(Boolean).pop() ?? "";
  for (const m of src.matchAll(/\(([^)]*)\)/g)) {
    const alias = nk(m[1]);
    if (alias.length < 2) continue;
    add(alias, !alias.includes(" "));
    if (last && !alias.split(" ").includes(last)) add(`${alias} ${last}`);
  }
  if (src.includes("/")) for (const part of src.split("/")) add(nk(part));
  variantCache.set(src, out);
  return out;
}

/* Same client across sources written differently ("Hang Le (Sydney)", "May
   Eubanks" vs "May Nguyen Eubanks"): equal, one inside the other, or the
   first and last word of one both appear in the other — tried for every pair
   of name variants (see nameVariants). */
function sameLoose(x: string, y: string): boolean {
  // Whole words only: "an nguyen" is not inside "loan nguyen" (it matched as
  // a substring and tied Loan Nguyen's payments to an offboarded namesake).
  const within = (short: string, long: string) => short.length > 5 && ` ${long} `.includes(` ${short} `);
  if (within(x, y) || within(y, x)) return true;
  const wx = x.split(" ").filter((w) => w.length > 1), wy = y.split(" ").filter((w) => w.length > 1);
  const fl = (w: string[]) => (w.length >= 2 ? [w[0], w[w.length - 1]] : null);
  const a2 = fl(wx), b2 = fl(wy);
  return (!!a2 && a2.every((w) => wy.includes(w))) || (!!b2 && b2.every((w) => wx.includes(w)));
}
export function sameClient(a: string, b: string): boolean {
  const va = nameVariants(a), vb = nameVariants(b);
  for (const x of va) {
    for (const y of vb) {
      if (!x.s || !y.s) continue;
      if (x.s === y.s) return true;
      if (!x.strict && !y.strict && sameLoose(x.s, y.s)) return true;
    }
  }
  return false;
}

/* How many months a Financing plan note covers (owner, 2026-10-19: "5 + 2
   months" is 7, "9 + 3 months - $4,500" is 12, "3 + 1 Months Plan" is 4):
   the numbers joined by "+" right before "month(s)" are summed; "quarterly"
   is 3; "whole year" / "annual" is 12 — unless the note says they pay
   monthly ("$6k Annualy … Paid monthly for now $697"). Null = no count. */
export function planMonths(note: string): number | null {
  const m = note.match(/((?:\d+\s*\+\s*)*\d+)\s*-?\s*months?\b/i);
  if (m) return m[1].split("+").reduce((t, x) => t + Number(x.trim()), 0);
  if (/quarter/i.test(note)) return 3;
  if (/whole\s*year|annual|yearly|full\s*year/i.test(note) && !/monthly|\/mo\b/i.test(note)) return 12;
  return null;
}

/* Prepaid coverage from the SHEET: a payment row whose note says the plan
   runs several months ("$3,485 - 5 + 2 months Plan") covers that month and
   the next n-1. No month count in the note: $1,791 / $2,091 are the quarterly
   plans, $3,485 the 6-month one — far above any monthly or first payment. A
   big first payment alone is often setup + first month, so a monthly-sized
   amount with no note stays one month. */
export type Coverage = { name: string; start: string; end: string; months: number; amount: number; label: string };
export const addMonths = (ym: string, n: number) => { const [y, mo] = ym.split("-").map(Number); return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7); };
/* A plan note alone is not a prepayment: "3 Months Plan (1/3)" and "$500/mo
   (2/3)" are paid month by month, and a $697 row under "3 Months Plan $2,091"
   is one instalment. Only a lump of at least this much covers several
   months (2026-10-19: the instalment rows hid 11 clients who had stopped). */
const PREPAID_MIN = 1500;
export const paidMonthly = (note: string) => /\(\s*\d+\s*\/\s*\d+\s*\)|\/\s*mo\b|monthly|per\s*month|each\s*month/i.test(note);
export function prepaidCoverage(months: MonthFinance[]): Coverage[] {
  const out: Coverage[] = [];
  for (const m of months) {
    for (const p of m.payers) {
      if (p.amount < PREPAID_MIN || paidMonthly(p.note)) continue;
      const n = planMonths(p.note) ?? (p.amount >= 3400 ? 6 : p.amount >= 1700 ? 3 : 1);
      if (n <= 1 || n > 12) continue;
      const end = addMonths(m.ym, n - 1);
      const prev = out.find((c) => sameClient(c.name, p.name));
      if (prev && prev.end >= end) continue;
      if (prev) out.splice(out.indexOf(prev), 1);
      out.push({ name: p.name, start: m.ym, end, months: n, amount: p.amount, label: m.label });
    }
  }
  return out;
}
/** The latest coverage entry for a client (alias-aware), if any. */
export const coverageOf = (cov: Coverage[], name: string): Coverage | null =>
  cov.filter((c) => sameClient(c.name, name)).sort((a, b) => a.end.localeCompare(b.end)).pop() ?? null;

/* Square plans: prepaid (quarterly / 6-month / yearly — they pay once and
   then show no row for months) and paused ones. From the stored snapshot. */
export type SquarePlans = {
  prepaid: Array<{ name: string; email: string; cadence: string; amount: number; through: string }>;
  paused: Array<{ name: string; email: string }>;
  /** Every ACTIVE Square plan (monthly included) — that client is paying. */
  active: Array<{ name: string; email: string }>;
};
export async function squarePlans(svc: ReturnType<typeof createServiceClient>): Promise<SquarePlans> {
  const snap = await readSquareSnapshot(svc).catch(() => null);
  const subs = ((snap?.payload as { subscriptions?: unknown[] } | undefined)?.subscriptions ?? []) as Array<Record<string, unknown>>;
  const out: SquarePlans = { prepaid: [], paused: [], active: [] };
  for (const sub of subs) {
    const status = String(sub.status ?? "").toUpperCase();
    const cadence = String(sub.cadence ?? "").toUpperCase();
    const amount = Number(sub.amountCents ?? 0) / 100;
    const name = String(sub.customerName ?? ""), email = String(sub.customerEmail ?? "").toLowerCase();
    if (status === "ACTIVE") out.active.push({ name, email });
    if (status === "ACTIVE" && (/QUARTER|SIX|ANNUAL|YEAR/.test(cadence) || (!cadence && amount >= 1500))) {
      out.prepaid.push({ name, email, cadence: cadence || "prepaid", amount, through: String(sub.chargedThroughDate ?? "") });
    } else if (/PAUSE/.test(status)) out.paused.push({ name, email });
  }
  return out;
}

/* Live clients (Clients Master, today) with no payment row in a month.
   Matched by owner or business name, or the owner's first two words inside a
   payer's name — the sheet writes "Hang Le (Sydney)" or the business. Some of
   these are spelling differences, so the list is for checking, not a verdict. */
function liveWithoutPayment(live: Array<Record<string, unknown>>, payerNames: string[], hasActivePlan: (d: Record<string, unknown>) => boolean) {
  // The payer's parenthetical alias too ("Oyunchimeg Erdenetsogt (Jessica
  // Lee)" pays for Jessica Lee) — only real two-word aliases, never "(3/3)".
  const keys = payerNames.flatMap((n) => [nk(n), ...nameVariants(n).filter((v) => !v.strict && v.s.includes(" ") && v.s.length > 5).map((v) => v.s)]);
  const has = (k: string) => !!k && keys.some((p) => p === k || p.includes(k) || k.includes(p));
  return live.filter((d) => {
    if (hasActivePlan(d)) return false; // paying on an active Square plan
    const owner = nk(d["Owner Full Name"]);
    const biz = nk(d["Business Name"]);
    const words = owner.split(" ").filter((w) => w.length > 1);
    const firstLast = words.length >= 2 ? [words[0], words[words.length - 1]] : [];
    const firstTwo = words.slice(0, 2);
    if (has(owner) || (biz.length > 4 && has(biz))) return false;
    // "Annie Luong (Xuan)" is paying as "Xuan Luong" — try the alias forms too.
    if (nameVariants(d["Owner Full Name"]).some((v) => !v.strict && v.s !== owner && v.s.includes(" ") && has(v.s))) return false;
    for (const pair of [firstLast, firstTwo]) {
      if (pair.length === 2 && keys.some((p) => pair.every((w) => p.split(" ").includes(w)))) return false;
    }
    return true;
  }).map((d) => ({ name: String(d["Owner Full Name"] ?? "").trim(), business: String(d["Business Name"] ?? "").trim(), version: String(d["Version"] ?? "").replace(/[()]/g, "").trim() }));
}

export type RoadResult = { months: GrowthMonth[]; liveCount: number; error?: string };
export async function getRoadTo100k(): Promise<RoadResult> {
  return (await getRoadWithFinance()).road;
}

/* The tracker plus what the month plan builds on: the raw Financing months
   (every row with its status), the Square plans, the prepaid coverage worked
   out from the plan notes, and the Demos sheet rows — one workbook read. */
export async function getRoadWithFinance(): Promise<{ road: RoadResult; finance: MonthFinance[]; plans: SquarePlans; coverage: Coverage[]; demoRows: Array<Record<string, unknown>> }> {
  const fin = await getAgencyFinance();
  const empty = { finance: [] as MonthFinance[], plans: { prepaid: [], paused: [], active: [] } as SquarePlans, coverage: [] as Coverage[], demoRows: [] as Array<Record<string, unknown>> };
  if (fin.error) return { road: { months: [], liveCount: 0, error: fin.error }, ...empty };
  const svc = createServiceClient();

  const plans = await squarePlans(svc);
  /* Prepaid in the SHEET too: one big row for several months ("$1,791
     quarterly", "upgraded to 7 months", "5 + 2 months plan - $3,485") — the
     plan note says how long it runs (see prepaidCoverage). */
  const coverage = prepaidCoverage(fin.months);
  const sheetCovered = (name: string, ym: string) => coverage.some((c) => c.end >= ym && sameClient(c.name, name));
  const isPrepaid = (name: string, ym?: string) => plans.prepaid.some((p) => sameClient(p.name, name)) || (!!ym && sheetCovered(name, ym));
  const hasActivePlan = (d: Record<string, unknown>) => {
    const email = String(d["Email"] ?? "").trim().toLowerCase();
    return plans.active.some((p) => (!!email && p.email === email) || sameClient(p.name, String(d["Owner Full Name"] ?? "")));
  };
  const live: Array<Record<string, unknown>> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await svc.from("clients_master").select("data").range(off, off + 999);
    if (error) break;
    for (const r of (data ?? []) as Array<{ data: Record<string, unknown> }>) {
      if (/^live$/i.test(String(r.data?.["col_1"] ?? "").trim())) live.push(r.data);
    }
    if (!data || data.length < 1000) break;
  }

  // Per-show fees by month (Square, the Monday PPS run).
  const fees = new Map<string, number>();
  const ppsOwners = new Set<string>(); // anyone Square ever billed per show
  for (let off = 0; ; off += 1000) {
    const { data, error } = await svc.from("ppa_charges").select("amount, charged_at, owner_key")
      .eq("charged", true).not("charged_at", "is", null).or("excluded.is.null,excluded.eq.false")
      .range(off, off + 999);
    if (error) break;
    for (const r of (data ?? []) as Array<{ amount: number | null; charged_at: string; owner_key: string | null }>) {
      if (r.owner_key) ppsOwners.add(nk(r.owner_key));
      const ym = r.charged_at.slice(0, 7);
      fees.set(ym, (fees.get(ym) ?? 0) + Number(r.amount ?? 0));
    }
    if (!data || data.length < 1000) break;
  }

  // Demos by the month of the demo itself ("Wednesday, June 3, 2026 13:00").
  const demoRows: Array<Record<string, unknown>> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await svc.from("sales_demos").select("data").range(off, off + 999);
    if (error) break;
    for (const r of (data ?? []) as Array<{ data: Record<string, unknown> }>) if (r.data) demoRows.push(r.data);
    if (!data || data.length < 1000) break;
  }
  const demos = new Map<string, { booked: number; showed: number; closed: number; noShow: number }>();
  for (const row of demoRows) {
    const ym = demoMonth(row["Demo Date"]);
    if (!ym) continue;
    const st = String(row["Status"] ?? "").trim();
    const d = demos.get(ym) ?? { booked: 0, showed: 0, closed: 0, noShow: 0 };
    d.booked++;
    if (/no-?show|cancel/i.test(st)) d.noShow++;
    else if (st) d.showed++;
    if (/^closed$|deposit collected/i.test(st)) d.closed++;
    demos.set(ym, d);
  }

  const nowYm = new Date().toISOString().slice(0, 7);
  const kept = fin.months.filter((m: MonthFinance) => m.ym >= "2026-04"); // the new sheet layout (profit on the tab)
  // "Live but not paying" only makes sense against today's Live list, so it
  // is worked out for the last full month and the current one.
  const recent = new Set(kept.slice(-2).map((m) => m.ym));
  const months: GrowthMonth[] = kept
    .map((m: MonthFinance) => {
      const d = demos.get(m.ym) ?? { booked: 0, showed: 0, closed: 0, noShow: 0 };
      // Per-show fees as the Financing sheet books them (same source as the
      // profit line); Square's own total is kept alongside as a cross-check.
      // Pay-per-appointment = the sheet note says so, OR Square bills them per
      // show (Vanessa Pak, Eric Collazo… have no "per show" note).
      const isPps = (p: { name: string; pps: boolean }) => {
        if (p.pps) return true;
        const k = nk(p.name);
        const two = k.split(" ").slice(0, 2);
        return [...ppsOwners].some((o) => o === k || (two.length === 2 && two.every((w) => o.split(" ").includes(w))));
      };
      const pps = m.payers.filter(isPps);
      const retainers = m.payers.filter((p) => !isPps(p));
      const ppsFeesSheet = Math.round(pps.reduce((t, p) => t + p.amount, 0));
      /* "Under $500" = a Live retainer client whose monthly payment is low —
         not a deposit, a credited month, an installment, a split plan or a
         prepaid plan's partial row (owner acts on this list). */
      const lowPayers = retainers.filter((p) => p.amount < 500
        && !/deposit|credit|install|toward|partial|half|split|\d+\s*%|\bx\s*\d|×/i.test(`${p.name} ${p.note}`)
        && !isPrepaid(p.name, m.ym)
        && live.some((d) => sameClient(String(d["Owner Full Name"] ?? ""), p.name)));
      const ppsFeesSquare = Math.round(fees.get(m.ym) ?? 0);
      // The PPS line uses what Square actually charged when it has it (the
      // sheet books only part of it); before the Square runs, the sheet's rows.
      const ppsFees = ppsFeesSquare || ppsFeesSheet;
      /* Not churn: prepaid, on a free month / helped this month ("Grace"), a
         $0 "Paid Upfront" row (owner, 2026-10-05: grace clients haven't left;
         owner, 2026-10-19: a Paid Upfront row is covered, full stop — their
         Square plan being paused is normal for prepaid clients), a pay-per-
         show client (no shows = $0, not gone) or a prospect's hold deposit. */
      const inSheetList = (list: string[], n: string) => list.some((g) => sameClient(g, n));
      const prevM = fin.months[fin.months.indexOf(m) - 1];
      const ppsAnywhere = (n: string) => inSheetList(m.ppsNames, n) || (!!prevM && inSheetList(prevM.ppsNames, n))
        || isPps({ name: n, pps: false });
      const depositOnly = (n: string) => inSheetList(m.depositOnlyNames, n) || (!!prevM && inSheetList(prevM.depositOnlyNames, n));
      const excused = (n: string) => isPrepaid(n, m.ym) || inSheetList(m.graceNames, n) || inSheetList(m.upfrontNames, n)
        || ppsAnywhere(n) || depositOnly(n);

      return {
        ym: m.ym, label: m.label, partial: m.ym >= nowYm,
        profit: m.totalProfit, income: m.totalIncome, expense: m.totalExpense,
        payingClients: m.payingClients, newClients: m.firstTimePayers.length,
        lostClients: m.lostClients == null ? null : m.lostNames.filter((n) => !excused(n)).length,
        under500: lowPayers.length,
        // What one RETAINER client paid this month, on average (their rows that
        // month; pay-per-appointment clients are left out — they pay per show).
        avgPerClient: retainers.length ? Math.round(retainers.reduce((t, p) => t + p.amount, 0) / retainers.length) : null,
        ppsDeposits: Math.round(m.depositIncome), ppsFees, ppsIncome: Math.round(m.depositIncome) + ppsFees,
        ppsFeesSquare,
        ppsClients: pps.length,
        // A prepaid quarterly / 6-month / yearly client skipping a month
        // hasn't left — not counted as "stopped paying" (owner, 2026-10-03).
        newList: m.firstTimePayers, lostList: m.lostNames.filter((n) => !excused(n)),
        graceList: m.graceNames,
        ppsList: m.ppsNames,
        under500List: lowPayers.map((p) => ({ name: p.name, amount: Math.round(p.amount) })),
        // Payer name + its plan note ("Sidney le beauty", the partner's name…) — the sheet's names drift.
        // Pay-per-show rows count as paying even at $0 (no shows yet, not gone).
        liveNotPaying: recent.has(m.ym)
          ? liveWithoutPayment(live, [...m.payers.map((p) => `${p.name} ${p.note}`), ...m.graceNames, ...m.upfrontNames, ...m.ppsNames], hasActivePlan).filter((c) => !isPrepaid(c.name, m.ym))
          : null,
        prepaidCount: live.filter((d) => isPrepaid(String(d["Owner Full Name"] ?? ""))).length,
        demosBooked: d.booked, demosShowed: d.showed, demosClosed: d.closed,
        // No-shows + cancellations as a share of all demos booked that month.
        noShowPct: d.booked ? Math.round((d.noShow / d.booked) * 100) : null,
        adSpend: m.adSpend, adPerClose: m.adSpend != null && d.closed ? Math.round(m.adSpend / d.closed) : null,
      };
    });
  return { road: { months, liveCount: live.length }, finance: fin.months, plans, coverage, demoRows };
}

/** "Wednesday, June 3, 2026 13:00" → "2026-06" (the Demos sheet's date style). */
export function demoMonth(raw: unknown): string | null {
  const m = String(raw ?? "").match(/([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
  if (!m) return null;
  const mi = MONTH_NAMES.indexOf(m[1].toLowerCase());
  return mi < 0 ? null : `${m[3]}-${String(mi + 1).padStart(2, "0")}`;
}
