import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { PERSON_DEDUPE_MS, personKeys } from "@/lib/onebox";

export const fetchCache = "force-no-store";
export const maxDuration = 60;

/* Instagram grid + Google reviews switch — health and before/after
   (owner, 10/28/2026: "how can we track that it works?").

   BEFORE = the 3 weeks before any visitor saw our own grid (A/B #4 started
   10/26 13:30 UTC). AFTER = since both in-house pieces were live for every
   visitor (Google reviews replaced Elfsight 10/27 12:35 UTC). The day in
   between was mixed and is left out.

   Counted per PERSON, not per form row: a returning lead updates every one
   of their rows when they pick or pay, so rows are grouped into journeys
   (same phone / email / name within 21 days, the dedupe the insights use)
   that belong to the window of their first visit; a journey that spans both
   windows is dropped. Qualified leads only; no B2B, no free-booking funnel.

   Same funnels on both sides, compared funnel by funnel (Mantel–Haenszel
   weights), so a funnel pausing or scaling its ads can't move the result;
   the test is a stratified (Cochran–Mantel–Haenszel) z across funnels.

   Deposits = paid on the funnel (booked / paid / paid-not-booked), leads 7+
   days old on both sides. Picked a time = leads 2 h+ old.

   The verdict is taken ONCE, at a fixed point — the first N people after
   the switch — so reloading the card daily can't fish for a false alarm.
   Before that it only says "worse" on an overwhelming drop (z ≤ −3). */

const BEFORE_FROM = "2026-10-05T13:30:00Z";
const BEFORE_TO = "2026-10-26T13:30:00Z";
const AFTER_FROM = "2026-10-27T12:35:00Z";
const LOOKBACK_FROM = "2026-09-14T13:30:00Z"; // to spot journeys that started before the window
const PAID = new Set(["booked", "paid", "paid-not-booked"]);
const PICK_N = 600; // people after the switch at the picked-a-time decision point
const DEP_N = 2000; // matured people after the switch at the deposit decision point
const PICK_AGE = 2 * 3600_000;
const DEP_AGE = 7 * 86400_000;

type Lead = { slug: string; created_at: string; ghl_status: string; picked_time_at: string | null; answers: Record<string, unknown> | null; full_name: string | null; phone: string | null };
type Journey = { slug: string; first: number; picked: boolean; paid: boolean; inBefore: boolean; inAfter: boolean; preWindow: boolean };
type Rate = { n: number; k: number; pct: number | null };
type Metric = { before: Rate; after: Rate; liftPct: number | null; z: number | null; verdict: "too_early" | "worse" | "better" | "same"; needN: number; decided: boolean };

const normVersion = (v: unknown) => (String(v ?? "").toUpperCase().includes("V3") ? "V3" : String(v ?? "").toUpperCase().includes("V2") ? "V2.3" : "other");
const disqualified = (a: Record<string, unknown> | null) => {
  const x = a ?? {};
  return x.disqualified === true || /^0-2/.test(String(x.seriousness ?? "")) || String(x.commutable ?? "").trim().toLowerCase() === "no";
};
const pct1 = (x: number) => Math.round(x * 1000) / 10;

/** Funnel-by-funnel comparison. `after` must already be cut to the decision sample.
    The after rate shown is the before rate plus the Mantel–Haenszel risk
    difference — the same funnel weights as the CMH z, so the % and the
    verdict always point the same way. */
function stratified(before: Journey[], after: Journey[], hit: (j: Journey) => boolean, needN: number, decided: boolean): Metric {
  const slugs = [...new Set(after.map((j) => j.slug))].filter((s) => before.some((j) => j.slug === s));
  if (!slugs.length) {
    // Nothing comparable yet — still show where "before" stood.
    const k = before.filter(hit).length;
    return { before: { n: before.length, k, pct: before.length ? pct1(k / before.length) : null }, after: { n: 0, k: 0, pct: null }, liftPct: null, z: null, verdict: "too_early", needN, decided: false };
  }
  let n1 = 0, k1 = 0, n2 = 0, k2 = 0, num = 0, den = 0, varSum = 0;
  for (const s of slugs) {
    const b = before.filter((j) => j.slug === s), a = after.filter((j) => j.slug === s);
    const bk = b.filter(hit).length, ak = a.filter(hit).length;
    n1 += b.length; k1 += bk; n2 += a.length; k2 += ak;
    const N = b.length + a.length, K = bk + ak;
    num += (ak * b.length - bk * a.length) / N;
    den += (b.length * a.length) / N;
    if (N > 1) varSum += (b.length * a.length * K * (N - K)) / (N * N * (N - 1));
  }
  const beforePct = n1 ? k1 / n1 : null;
  const rd = den > 0 ? num / den : 0; // after − before, funnel-weighted
  const afterPct = beforePct == null ? null : Math.max(0, Math.min(1, beforePct + rd));
  const z = varSum > 0 ? Math.round((num / Math.sqrt(varSum)) * 100) / 100 : null;
  const liftPct = beforePct ? Math.round((rd / beforePct) * 100) : null;
  const verdict: Metric["verdict"] = !decided
    ? (z != null && z <= -3 && n2 >= 200 ? "worse" : "too_early")
    : z == null ? "same" : z <= -2 ? "worse" : z >= 2 ? "better" : "same";
  return {
    before: { n: n1, k: k1, pct: beforePct == null ? null : pct1(beforePct) },
    after: { n: n2, k: k2, pct: afterPct == null ? null : pct1(afterPct) },
    liftPct, z, verdict, needN, decided,
  };
}

export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const svc = createServiceClient();

  const leads: Lead[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await svc.from("onebox_leads").select("slug, created_at, ghl_status, picked_time_at, answers, full_name, phone").gte("created_at", LOOKBACK_FROM).order("id").range(from, from + 999);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    leads.push(...((data ?? []) as Lead[]));
    if (!data || data.length < 1000) break;
  }
  const [{ data: clients }, { data: act }, { data: ov }, { data: runs }, { count: openAlerts }] = await Promise.all([
    svc.from("onebox_clients").select("slug, extras").eq("status", "live"),
    svc.from("onebox_active_clients").select("owner_name, slug"),
    svc.from("deposit_overview").select("owner_name, version"),
    svc.from("funnel_health_runs").select("ran_at, checked, grid_ok, reviews_ok, problems, details").order("ran_at", { ascending: false }).limit(1),
    svc.from("alerts").select("id", { count: "exact", head: true }).eq("type", "funnel_widgets").eq("status", "open"),
  ]);

  const verByOwner = new Map((ov ?? []).map((r) => [String(r.owner_name ?? "").toLowerCase().trim(), normVersion(r.version)]));
  const verBySlug = new Map((act ?? []).map((a) => [String(a.slug), verByOwner.get(String(a.owner_name ?? "").toLowerCase().trim()) ?? "other"]));
  const eligible = new Set(
    (clients ?? [])
      .filter((c) => { const ex = (c.extras ?? {}) as { template?: string; freeBooking?: boolean }; return ex.template !== "b2b" && !ex.freeBooking; })
      .map((c) => String(c.slug)),
  );

  // Rows → journeys (per funnel, per person).
  const t = (iso: string) => Date.parse(iso);
  const bFrom = t(BEFORE_FROM), bTo = t(BEFORE_TO), aFrom = t(AFTER_FROM);
  const qual = leads.filter((l) => eligible.has(l.slug) && !disqualified(l.answers) && !/test/i.test(l.full_name ?? ""))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const index = new Map<string, Journey>();
  const journeys: Journey[] = [];
  for (const l of qual) {
    const ms = t(l.created_at);
    const keys = personKeys(l.full_name ?? "", String((l.answers ?? {}).email ?? ""), l.phone ?? "").map((k) => `${l.slug}|${k}`);
    let j = keys.map((k) => index.get(k)).find((x) => x && ms - x.first < PERSON_DEDUPE_MS);
    if (!j) { j = { slug: l.slug, first: ms, picked: false, paid: false, inBefore: false, inAfter: false, preWindow: ms < bFrom }; journeys.push(j); }
    if (ms >= bFrom && ms < bTo) j.inBefore = true;
    if (ms >= aFrom) j.inAfter = true;
    if (l.picked_time_at || PAID.has(l.ghl_status)) j.picked = true;
    if (PAID.has(l.ghl_status)) j.paid = true;
    for (const k of keys) index.set(k, j);
  }
  const now = Date.now();
  const clean = journeys.filter((j) => !j.preWindow && !(j.inBefore && j.inAfter));
  const before = clean.filter((j) => j.first >= bFrom && j.first < bTo);
  const after = clean.filter((j) => j.first >= aFrom);
  const picked = (j: Journey) => j.picked;
  const paid = (j: Journey) => j.paid;

  const group = (ver: "all" | "V3" | "V2.3") => {
    const inV = (j: Journey) => ver === "all" || verBySlug.get(j.slug) === ver;
    const pickN = ver === "all" ? PICK_N : Math.round(PICK_N / 2);
    const depN = ver === "all" ? DEP_N : Math.round(DEP_N * 0.6);
    const b = before.filter(inV);
    const bDep = b.filter((j) => now - j.first >= DEP_AGE);
    // The decision sample: the first N people after the switch (fixed once reached).
    const aPickAll = after.filter((j) => inV(j) && now - j.first >= PICK_AGE);
    const aDepAll = after.filter((j) => inV(j) && now - j.first >= DEP_AGE);
    const aPick = aPickAll.slice(0, pickN), aDep = aDepAll.slice(0, depN);
    return {
      funnels: [...new Set(after.filter(inV).map((j) => j.slug))].filter((sl) => b.some((j) => j.slug === sl)).length,
      picked: stratified(b, aPick, picked, pickN, aPickAll.length >= pickN),
      deposits: stratified(bDep, aDep, paid, depN, aDepAll.length >= depN),
    };
  };
  const all = group("all");

  // When the deposit verdict is due: people still to collect, then 7 days for the last of them to pay.
  const daysAfter = Math.max(0.5, (now - aFrom) / 86400_000);
  const perDay = after.length / daysAfter;
  const eta = all.deposits.decided || perDay <= 0
    ? null
    : new Date(now + (Math.max(0, (DEP_N - after.length) / perDay) + DEP_AGE / 86400_000) * 86400_000).toISOString();

  return NextResponse.json({
    windows: { beforeFrom: BEFORE_FROM, beforeTo: BEFORE_TO, afterFrom: AFTER_FROM },
    all,
    v3: group("V3"),
    v23: group("V2.3"),
    depositVerdictEta: eta,
    health: runs?.[0] ?? null,
    openAlerts: openAlerts ?? 0,
  });
}
