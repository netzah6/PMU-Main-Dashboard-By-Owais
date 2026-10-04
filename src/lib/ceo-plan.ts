import { createServiceClient } from "@/lib/supabase/server";
import { getRoadTo100k, PROFIT_GOAL, TARGETS, nk, sameClient, squarePlans } from "@/lib/ceo-growth";

/* "A plan every month so I know exactly what I need to do" (owner,
   2026-10-04). Built fresh from the data each time it opens — never typed by
   hand — so it is always this month's real list:
     • this month's profit goal: a straight line from last month's profit to
       $100k by GOAL_MONTH
     • one section per lever, each with a target, where last month landed,
       and the exact to-dos WITH NAMES (who to win back, who to restart, who
       to raise, whose call workflow to fix, sales call targets)
   Ticks are saved per month (ceo_plan_done), so next month starts clean. */

export const GOAL_MONTH = "2027-03";

export type PlanItem = { key: string; text: string; detail?: string; done: { by: string | null; at: string } | null };
export type PlanSection = { key: string; title: string; why: string; target: string; last: string; ok: boolean | null; items: PlanItem[] };
export type MonthPlan = {
  ym: string; label: string; goalMonth: string;
  profitGoal: number | null; lastLabel: string; lastProfit: number | null;
  sections: PlanSection[];
};

const monthsBetween = (a: string, b: string) => {
  const [ay, am] = a.split("-").map(Number), [by, bm] = b.split("-").map(Number);
  return (by - ay) * 12 + (bm - am);
};
const usd = (n: number) => `$${Math.round(n).toLocaleString()}`;


export async function buildMonthPlan(): Promise<MonthPlan | { error: string }> {
  const road = await getRoadTo100k();
  if (road.error || !road.months.length) return { error: road.error ?? "no finance data" };
  const svc = createServiceClient();
  // The plan is for the CALENDAR month (even before its Financing tab
  // exists); "last" = the latest finished month that has a profit figure.
  const now = new Date();
  const curYm = now.toISOString().slice(0, 7);
  const curLabel = now.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  const last = [...road.months].reverse().find((m) => m.ym < curYm && m.profit != null)
    ?? [...road.months].reverse().find((m) => m.ym < curYm) ?? road.months[road.months.length - 1];

  // Profit goal for THIS month on a straight line to $100k by GOAL_MONTH.
  const steps = Math.max(1, monthsBetween(last.ym, GOAL_MONTH));
  const profitGoal = last.profit == null ? null : Math.min(PROFIT_GOAL,
    Math.round((last.profit + ((PROFIT_GOAL - last.profit) / steps) * Math.max(1, monthsBetween(last.ym, curYm))) / 500) * 500);

  const [{ data: doneRows }, cmRows, plans, { data: killRows }, { data: fixRows }, ppaOwners, deps] = await Promise.all([
    svc.from("ceo_plan_done").select("item_key, done_by, done_at").eq("ym", curYm),
    (async () => {
      const out: Array<Record<string, unknown>> = [];
      for (let off = 0; ; off += 1000) {
        const { data } = await svc.from("clients_master").select("data").range(off, off + 999);
        for (const r of (data ?? []) as Array<{ data: Record<string, unknown> }>) out.push(r.data);
        if (!data || data.length < 1000) break;
      }
      return out;
    })(),
    squarePlans(svc),
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
    // Deposits in the last 30 days per client — the same numbers as the CPD tab.
    svc.from("deposit_overview").select("owner_name, d30").then(({ data }) =>
      ((data ?? []) as Array<{ owner_name: string | null; d30: number | null }>).map((r) => ({ name: String(r.owner_name ?? ""), d30: Number(r.d30 ?? 0) }))),
  ]);
  const done = new Map(((doneRows ?? []) as Array<{ item_key: string; done_by: string | null; done_at: string }>).map((r) => [r.item_key, { by: r.done_by, at: r.done_at }]));
  const item = (section: string, who: string, text: string, detail?: string): PlanItem => {
    // section + action + person: one person can have two different to-dos.
    const key = `${section}:${nk(text.split(" ").slice(0, 2).join(" "))}:${nk(who) || nk(text)}`;
    return { key, text, detail, done: done.get(key) ?? null };
  };

  const live = cmRows.filter((d) => /^live$/i.test(String(d["col_1"] ?? "").trim()));
  const liveName = (d: Record<string, unknown>) => String(d["Owner Full Name"] ?? "").trim();
  // The current month is still filling in — last month's lists drive the to-dos.
  const isPps = (name: string) => ppaOwners.some((o) => sameClient(o, name));
  const statusOf = (name: string) => String(cmRows.find((d) => sameClient(liveName(d), name))?.["col_1"] ?? "").trim();
  // Live clients who paid NOTHING last month (prepaid plans already left out).
  const unpaid = last.liveNotPaying ?? [];
  // …of those (not pay-per-appointment), the ones whose Square plan is paused.
  const pausedLive = unpaid.filter((c) => !isPps(c.name)).filter((c) => {
    const d = live.find((x) => sameClient(liveName(x), c.name));
    const email = String(d?.["Email"] ?? "").trim().toLowerCase();
    return plans.paused.some((p) => sameClient(p.name, c.name) || (!!p.email && p.email === email));
  });

  // 1 · Keep clients
  // Win back: stopped paying last month and still Live / Paused on the
  // Clients sheet (already-offboarded ones left on purpose).
  // Pay-per-appointment clients are handled in section 3 (deposits), not here.
  const winBack = last.lostList.filter((n) => /^(live|paused)$/i.test(statusOf(n)) && !isPps(n));
  const keepItems: PlanItem[] = [
    ...winBack.map((n) => item("keep", n, `Win back ${n}`, `Paid before ${last.label}, nothing in ${last.label} · ${statusOf(n)} on the Clients sheet`)),
    ...pausedLive
      .filter((c) => !winBack.some((n) => sameClient(n, c.name)))
      .map((c) => item("keep", c.name, `Restart or offboard ${c.name}`, `Square plan paused, nothing paid in ${last.label}, still Live`)),
    ...unpaid
      .filter((c) => !isPps(c.name) && !pausedLive.some((x) => sameClient(x.name, c.name)) && !winBack.some((n) => sameClient(n, c.name)))
      .map((c) => item("keep", c.name, `Collect from or offboard ${c.name}`, `Live, but no payment found in ${last.label}`)),
  ];

  // 2 · Raise the floor
  // Partners splitting one plan ("Erin 30%", "Ayesha 70%") pay together — not a discount.
  const floorItems: PlanItem[] = last.under500List.filter((x) => !/\d+\s*%/.test(x.name)).map((x) =>
    item("floor", x.name, `Raise ${x.name} to $597`, `Paid ${usd(x.amount)} in ${last.label}`));

  // 3 · Per-appointment money
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
  const ppsNoDeposits = live
    .filter((d) => isPps(liveName(d)))
    .filter((d) => { const r = deps.find((x) => sameClient(x.name, liveName(d))); return !!r && r.d30 === 0; })
    .map((d) => item("pps", liveName(d), `Get ${liveName(d)} deposits again`, "Pay-per-appointment, 0 deposits in the last 30 days — check ads and funnel"));
  const ppsItems = [...killItems, ...ppsNoDeposits];

  // 4 · Sales calls
  const closeRate = last.demosShowed ? last.demosClosed / last.demosShowed : 0.4;
  const showRate = 1 - TARGETS.noShowMaxPct / 100;
  const demosNeeded = Math.ceil(TARGETS.closesMin / Math.max(0.2, closeRate) / showRate);
  const salesItems: PlanItem[] = [
    item("sales", "confirm", `Confirm every demo the day before and 2 hours before`, `${last.noShowPct ?? "—"}% missed in ${last.label} — goal ${TARGETS.noShowMaxPct}% or less`),
    item("sales", "book", `Book ${demosNeeded}+ demo calls this month`, `${last.demosBooked} booked in ${last.label}; at ${Math.round(closeRate * 100)}% close that gives ${TARGETS.closesMin} clients`),
    item("sales", "close", `Close ${TARGETS.closesMin}+ new clients`, `${last.demosClosed} closed in ${last.label}`),
  ];

  return {
    ym: curYm, label: curLabel, goalMonth: GOAL_MONTH,
    profitGoal, lastLabel: last.label, lastProfit: last.profit,
    sections: [
      { key: "keep", title: "1 · Keep every client", why: "Clients who stop paying are the biggest leak.", target: `${TARGETS.lostMax} or fewer stop paying`, last: `${last.lostClients ?? "—"} stopped in ${last.label}`, ok: last.lostClients != null ? last.lostClients <= TARGETS.lostMax : null, items: keepItems },
      { key: "floor", title: "2 · No retainer under $500", why: "Every retainer client should pay at least $597.", target: "0 under $500", last: `${last.under500} under $500 in ${last.label}`, ok: last.under500 <= TARGETS.under500Max, items: floorItems },
      { key: "pps", title: "3 · Grow per-appointment money", why: "More deposits = more money we keep + happier clients.", target: `${usd(TARGETS.ppsMin)}+ a month`, last: `${usd(last.ppsIncome)} in ${last.label}`, ok: last.ppsIncome >= TARGETS.ppsMin, items: ppsItems },
      { key: "sales", title: "4 · Sign more clients", why: "Fewer missed calls and more demos = more new clients.", target: `${TARGETS.closesMin}+ closed, ≤${TARGETS.noShowMaxPct}% missed`, last: `${last.demosClosed} closed, ${last.noShowPct ?? "—"}% missed in ${last.label}`, ok: last.demosClosed >= TARGETS.closesMin && (last.noShowPct ?? 100) <= TARGETS.noShowMaxPct, items: salesItems },
    ],
  };
}


