import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";

export const fetchCache = "force-no-store";
export const maxDuration = 60;

/* Instagram grid + Google reviews switch — health and before/after
   (owner, 10/28/2026: "how can we track that it works?").

   BEFORE = the 3 weeks before any visitor saw our own grid (A/B #4 started
   10/26 13:30 UTC). AFTER = since both in-house pieces were live for every
   visitor (Google reviews replaced Elfsight 10/27 12:35 UTC). The day in
   between was mixed and is left out.

   Same funnels on both sides (live now, had leads before, not B2B, not the
   free-booking funnel whose "booked" counts as paid). Qualified leads only.
   Picked-a-time counts leads 2 h+ old; deposits count only leads 3+ days
   old, because 87% of deposits land within a day and ~96% by day 5 — a
   younger lead hasn't had its chance to pay yet.

   This is a before/after, not a controlled test: the other changes of those
   weeks (running A/B tests, offer edits, new ads) move the same numbers, so
   only a clear, statistically solid drop is called "worse". */

const BEFORE_FROM = "2026-10-05T13:30:00Z";
const BEFORE_TO = "2026-10-26T13:30:00Z";
const AFTER_FROM = "2026-10-27T12:35:00Z";
const PAID = new Set(["booked", "paid", "paid-not-booked", "paid-followup"]);
const MIN_PICK_N = 600; // leads after the switch before the picked-a-time verdict
const MIN_DEP_N = 2000; // matured leads after the switch before the deposit verdict

type Lead = { slug: string; created_at: string; ghl_status: string; picked_time_at: string | null; answers: Record<string, unknown> | null; full_name: string | null };
type Rate = { n: number; k: number; pct: number | null };
type Metric = { before: Rate; after: Rate; liftPct: number | null; z: number | null; verdict: "too_early" | "worse" | "better" | "same"; needN: number };

const rate = (k: number, n: number): Rate => ({ n, k, pct: n ? Math.round((k / n) * 1000) / 10 : null });
function compare(before: Rate, after: Rate, minN: number): Metric {
  const liftPct = before.pct && after.pct != null ? Math.round(((after.pct - before.pct) / before.pct) * 100) : null;
  let z: number | null = null;
  if (before.n && after.n) {
    const p = (before.k + after.k) / (before.n + after.n);
    const se = Math.sqrt(p * (1 - p) * (1 / before.n + 1 / after.n));
    z = se > 0 ? Math.round(((after.k / after.n - before.k / before.n) / se) * 100) / 100 : 0;
  }
  // A clear drop is reported as soon as it's clear; "better"/"same" wait for enough data.
  const verdict: Metric["verdict"] = z != null && z <= -2.5 && after.n >= 200 ? "worse" : after.n < minN ? "too_early" : z != null && z <= -2 ? "worse" : z != null && z >= 2 ? "better" : "same";
  return { before, after, liftPct, z, verdict, needN: minN };
}
const normVersion = (v: unknown) => (String(v ?? "").toUpperCase().includes("V3") ? "V3" : String(v ?? "").toUpperCase().includes("V2") ? "V2.3" : "other");
const disqualified = (a: Record<string, unknown> | null) => {
  const x = a ?? {};
  return x.disqualified === true || /^0-2/.test(String(x.seriousness ?? "")) || String(x.commutable ?? "").trim().toLowerCase() === "no";
};

export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const svc = createServiceClient();

  const leads: Lead[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await svc.from("onebox_leads").select("slug, created_at, ghl_status, picked_time_at, answers, full_name").gte("created_at", BEFORE_FROM).order("id").range(from, from + 999);
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

  const qual = leads.filter((l) => eligible.has(l.slug) && !disqualified(l.answers) && !/test/i.test(l.full_name ?? ""));
  const t = (iso: string) => Date.parse(iso);
  const before = qual.filter((l) => t(l.created_at) < t(BEFORE_TO));
  const beforeSlugs = new Set(before.map((l) => l.slug));
  const now = Date.now();
  const after = qual.filter((l) => t(l.created_at) >= t(AFTER_FROM) && beforeSlugs.has(l.slug));
  const picked = (l: Lead) => !!l.picked_time_at || PAID.has(l.ghl_status);
  const paid = (l: Lead) => PAID.has(l.ghl_status);

  const group = (ver: "all" | "V3" | "V2.3") => {
    const inV = (l: Lead) => ver === "all" || verBySlug.get(l.slug) === ver;
    const b = before.filter(inV);
    const aPick = after.filter((l) => inV(l) && now - t(l.created_at) >= 2 * 3600_000);
    const aDep = after.filter((l) => inV(l) && now - t(l.created_at) >= 3 * 86400_000);
    return {
      funnels: new Set(b.map((l) => l.slug)).size,
      picked: compare(rate(b.filter(picked).length, b.length), rate(aPick.filter(picked).length, aPick.length), ver === "all" ? MIN_PICK_N : Math.round(MIN_PICK_N / 2)),
      deposits: compare(rate(b.filter(paid).length, b.length), rate(aDep.filter(paid).length, aDep.length), ver === "all" ? MIN_DEP_N : Math.round(MIN_DEP_N * 0.7)),
    };
  };

  // When the deposit verdict should be readable: leads/day since the switch + the 3-day maturity lag.
  const daysAfter = Math.max(0.5, (now - t(AFTER_FROM)) / 86400_000);
  const perDay = after.length / daysAfter;
  const allDep = group("all").deposits;
  // Leads still to collect, then 3 days for the last of them to have had their chance to pay.
  const eta = allDep.after.n >= MIN_DEP_N || perDay <= 0
    ? null
    : new Date(now + (Math.max(0, (MIN_DEP_N - after.length) / perDay) + 3) * 86400_000).toISOString();

  return NextResponse.json({
    windows: { beforeFrom: BEFORE_FROM, beforeTo: BEFORE_TO, afterFrom: AFTER_FROM },
    all: group("all"),
    v3: group("V3"),
    v23: group("V2.3"),
    depositVerdictEta: eta,
    health: runs?.[0] ?? null,
    openAlerts: openAlerts ?? 0,
  });
}
