import type { SupabaseClient } from "@supabase/supabase-js";
import { PERSON_DEDUPE_MS, personKeys } from "@/lib/onebox";
import { fetchProgramRows, findClientProgram } from "@/lib/client-program";

// ── One-box funnel optimizer ─────────────────────────────────────────────────
// Watches every live B2C one-box funnel and, once a client has ENOUGH data,
// files a proposed insight: the problem, why the numbers say so, and the fix.
// Nothing changes on its own — every proposal waits for an explicit approve
// or deny on the Funnels tab. Deny (with a reason or a better idea) puts the
// rule on a cooldown so the same flag doesn't nag right back.

export type FunnelStat = {
  slug: string; clientName: string;
  visitors: number; leads: number; leadRate: number | null;
  picked: number; pickRate: number | null;
  deposits: number; aiDeposits: number;
  spend: number | null; costPerBooking: number | null;
};

/* PostgREST silently caps every select at 1,000 rows — a truncation that
   once made busy weeks look quiet (visitors vanished; the optimizer filed
   "no traffic" flags about clients with 166 real visitors). So visitor
   numbers are COUNTED per slug instead of fetched, and row fetches page
   until exhausted. */
export async function countHitsBySlug(svc: SupabaseClient, slugs: string[], sinceIso?: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await Promise.all(slugs.map(async (slug) => {
    let q = svc.from("onebox_hits").select("slug", { count: "exact", head: true }).eq("slug", slug);
    if (sinceIso) q = q.gte("created_at", sinceIso);
    const { count } = await q;
    out[slug] = count ?? 0;
  }));
  return out;
}

export async function fetchAllRows<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await page(from, from + 999);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

/* Funnel-wide numbers for the window, per live B2C client — the exact same
   journey rules the split tables used (21-day person dedupe; paid implies
   picked). Shared by the performance overview and the optimizer so the two
   can never disagree. */
export async function computeFunnelStats(svc: SupabaseClient, days: 7 | 14 | 30): Promise<FunnelStat[]> {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data: clients } = await svc
    .from("onebox_clients")
    .select("slug, client_name, status, extras")
    .eq("status", "live")
    .not("slug", "in", "(demo-v3,pmu-bookings)");
  const live = (clients ?? []).filter((c) => ((c.extras ?? {}) as { template?: string }).template !== "b2b");
  const slugs = live.map((c) => c.slug as string);
  const [winLeads, hitC, { data: perfRows }] = await Promise.all([
    fetchAllRows((from, to) =>
      svc.from("onebox_leads").select("slug, ghl_status, picked_time_at, answers, created_at, phone, full_name")
        .in("slug", slugs).gte("created_at", since).order("id").range(from, to)),
    countHitsBySlug(svc, slugs, since),
    svc.from("performance_overview").select("owner_name, spent7, spent14, cpl30, l30"),
  ]);

  return live.map((c) => {
    const slug = c.slug as string;
    type J = { ms: number; picked: boolean; paid: boolean; aiPaid: boolean };
    const journeys = new Map<string, J>();
    let nLeads = 0, nPicked = 0, nPaid = 0, nAi = 0;
    const mine = (winLeads ?? []).filter((l) => l.slug === slug)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    for (const l of mine) {
      const ms = new Date(l.created_at as string).getTime();
      const keys = personKeys(l.full_name as string, ((l.answers ?? {}) as { email?: string }).email, l.phone as string);
      let j: J | undefined;
      for (const key of keys) {
        const hit = journeys.get(key);
        if (hit && ms - hit.ms < PERSON_DEDUPE_MS) { j = hit; break; }
      }
      const paid = l.ghl_status === "booked" || l.ghl_status === "paid" || l.ghl_status === "paid-not-booked";
      const aiPaid = l.ghl_status === "paid-followup";
      const picked = paid || aiPaid || !!l.picked_time_at;
      if (!j) { j = { ms, picked: false, paid: false, aiPaid: false }; nLeads++; }
      if (picked && !j.picked) { nPicked++; j.picked = true; }
      if (paid && !j.paid) { nPaid++; j.paid = true; }
      if (aiPaid && !j.aiPaid) { nAi++; j.aiPaid = true; }
      for (const key of keys) journeys.set(key, j);
    }
    const pinned = ((c.extras ?? {}) as { ownerName?: string }).ownerName?.trim();
    const candidates: string[] = [];
    if (pinned) candidates.push(pinned);
    else {
      const name = String(c.client_name ?? "");
      candidates.push(name);
      for (const w of name.split(/\s+/)) {
        if (w.length > 3 && !/^(pmu|by|the|and|llc|inc|studio|beauty)$/i.test(w)) candidates.push(w);
      }
    }
    let spend: number | null = null;
    for (const cand of candidates) {
      if (!cand) continue;
      const low = cand.toLowerCase();
      const perf = (perfRows ?? []).find((p) => String(p.owner_name ?? "").toLowerCase().includes(low));
      /* The ad sheet has no spent30 column, but CPL × leads IS spend, so
         the 30-day window derives it from cpl30 · l30 (same source data). */
      const val = perf
        ? days === 7 ? perf.spent7
          : days === 14 ? perf.spent14
          : perf.cpl30 != null && perf.l30 != null ? Number(perf.cpl30) * Number(perf.l30) : null
        : null;
      if (val != null) { spend = Number(val); break; }
    }
    const vis = hitC[slug] ?? 0;
    return {
      slug, clientName: c.client_name as string,
      visitors: vis, leads: nLeads,
      leadRate: vis ? Math.round((nLeads / vis) * 1000) / 10 : null,
      picked: nPicked,
      pickRate: vis ? Math.round((nPicked / vis) * 1000) / 10 : null,
      deposits: nPaid, aiDeposits: nAi,
      spend: spend != null ? Math.round(spend * 100) / 100 : null,
      costPerBooking: spend != null && nPicked > 0 ? Math.round((spend / nPicked) * 100) / 100 : null,
    };
  }).sort((a, b) => b.visitors - a.visitors);
}

type Proposal = { slug: string; kind: string; problem: string; why: string; solution: string; metrics: Record<string, unknown> };

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/* How many of the next 21 days have at least one open time — asked of the
   same public slots API the funnel itself uses, so what the optimizer sees
   is exactly what a visitor sees. */
async function slotDays(origin: string, slugs: string[]): Promise<Record<string, number>> {
  const start = Date.now(), end = start + 21 * 86400000;
  const out: Record<string, number> = {};
  const queue = [...slugs];
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      try {
        const r = await fetch(`${origin}/api/onebox/slots?slug=${s}&start=${start}&end=${end}`, { signal: AbortSignal.timeout(20000) });
        const j = (await r.json()) as { ok?: boolean; dates?: Record<string, string[]> };
        if (j.ok) out[s] = Object.keys(j.dates ?? {}).length;
      } catch { /* unknown — rule skips this slug rather than false-flag */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, slugs.length) }, worker));
  return out;
}

/* The rules. Every one is gated on ENOUGH DATA for its own claim, and every
   "why" cites the client's numbers against the fleet, so the card stands on
   evidence, not vibes. Deposits are the target metric (V3 = pay-per-deposit
   economics), so each rule ends at "…and that costs deposits". */
function runRules(
  stats: FunnelStat[],
  days: Record<string, number | undefined>,
  ageDays: Record<string, number>
): Proposal[] {
  const out: Proposal[] = [];
  const withVol = stats.filter((s) => s.visitors >= 50);
  const medLead = median(withVol.map((s) => s.leadRate ?? 0).filter((x) => x > 0));
  const payThrough = (s: FunnelStat) => (s.picked > 0 ? (s.deposits + s.aiDeposits) / s.picked : null);
  const medPay = median(withVol.map(payThrough).filter((x): x is number => x != null && x > 0));
  const medCpd = median(withVol.map((s) => s.costPerBooking).filter((x): x is number => x != null && x > 0));

  for (const s of stats) {
    const dWithSlots = days[s.slug];
    const age = ageDays[s.slug] ?? 999;

    // 1. Dead traffic — a live funnel nobody reaches is the most expensive bug.
    if (s.visitors < 5 && age >= 7) {
      out.push({
        slug: s.slug, kind: "no-traffic",
        problem: "Almost no ad traffic is reaching the funnel",
        why: `Only ${s.visitors} visitors in the last 14 days on a live funnel. Either the ads are off, or the ad's URL redirect broke — every ad click is being wasted.`,
        solution: "Check the Meta ads are running, then I'll verify the ad URL → splitter → funnel chain end to end and fix whatever link is broken.",
        metrics: { visitors: s.visitors },
      });
    }

    // 2. Thin calendar — visitors who can't find a day that fits don't deposit.
    if (dWithSlots != null && dWithSlots < 5) {
      out.push({
        slug: s.slug, kind: "thin-calendar",
        problem: `Calendar has open times on only ${dWithSlots} day${dWithSlots === 1 ? "" : "s"} in the next 3 weeks`,
        why: `The rest of the fleet shows 7–20 open days. A visitor who can't make ${dWithSlots === 1 ? "that one day" : "those few days"} has nothing to pick — they leave without paying.`,
        solution: "Have the artist open availability across more days in her GHL calendar (a few times on 7+ days beats many times on 1–2 days; the funnel already shows max 5 per day for scarcity).",
        metrics: { daysWithSlots: dWithSlots },
      });
    }

    // 3. Weak top of funnel — enough visitors, few starting the survey.
    if (medLead != null && s.visitors >= 80 && s.leadRate != null && s.leadRate < medLead * 0.6) {
      out.push({
        slug: s.slug, kind: "low-lead-rate",
        problem: `Lead rate ${s.leadRate}% vs fleet median ${Math.round(medLead * 10) / 10}%`,
        why: `${s.visitors} visitors but only ${s.leads} became leads — the first page is losing people the other funnels keep. Usually the ad promise and the page don't match, or the traffic is off-audience.`,
        solution: "Compare her ad creative/audience against a top performer's, and align the funnel offer text (Values) with what the ad promises.",
        metrics: { visitors: s.visitors, leads: s.leads, leadRate: s.leadRate, fleetMedian: medLead },
      });
    }

    // 4. Pick→pay leak — they choose a time, then don't deposit.
    const pt = payThrough(s);
    if (medPay != null && s.picked >= 8 && pt != null && pt < medPay * 0.6) {
      out.push({
        slug: s.slug, kind: "pick-pay-leak",
        problem: `${s.picked} people picked a time but only ${s.deposits + s.aiDeposits} paid the deposit`,
        why: `That's ${Math.round(pt * 100)}% pay-through vs the fleet's ${Math.round(medPay * 100)}% — the leak is between choosing a time and paying, not in getting leads.`,
        solution: "Confirm the AI follow-up text fires at exactly 8 minutes for this client (the proven payment bump), and I'll run a live checkout test on her page to rule out a slow/broken payment box.",
        metrics: { picked: s.picked, paid: s.deposits + s.aiDeposits, payThrough: pt, fleetMedian: medPay },
      });
    }

    // 5. Zero deposits at volume — that's a broken step, not bad luck.
    // (Skipped when the pick→pay flag already fired: one leak, one card.)
    if (s.leads >= 15 && s.deposits + s.aiDeposits === 0 &&
        !out.some((p) => p.slug === s.slug && p.kind === "pick-pay-leak")) {
      out.push({
        slug: s.slug, kind: "no-deposits",
        problem: `${s.leads} leads in 14 days and not a single deposit`,
        why: "At this volume even a weak funnel produces some deposits — zero means something in the pay path is likely broken (checkout, calendar hand-off, or the AI reach-out is off).",
        solution: "I'll run the full chain on her funnel (survey → time pick → checkout) and check her AI follow-up is actually sending — then fix what's broken.",
        metrics: { leads: s.leads, picked: s.picked },
      });
    }

    // 6. Paying way over the odds per booking.
    if (medCpd != null && s.spend != null && s.spend >= 300 && s.costPerBooking != null && s.costPerBooking > medCpd * 2) {
      out.push({
        slug: s.slug, kind: "high-cpd",
        problem: `Cost per booking $${s.costPerBooking} vs fleet median $${Math.round(medCpd)}`,
        why: `$${s.spend} spent in 14 days for ${s.picked} bookings — more than double what the fleet pays for the same result. The budget is buying the wrong clicks.`,
        solution: "Flag to the media buyer: review targeting/ad sets against a top performer and shift budget to what converts.",
        metrics: { spend: s.spend, picked: s.picked, costPerBooking: s.costPerBooking, fleetMedian: medCpd },
      });
    }
  }
  return out;
}

/* One scan: compute stats, ask the calendar, run the rules, file anything new
   as a 'proposed' insight. A (slug, kind) that is already open, or that was
   decided in the last 21 days, is skipped — approve/deny means "heard you". */
export async function runInsightScan(svc: SupabaseClient, origin: string): Promise<{ created: number; open: number; checked: number }> {
  const allStats = await computeFunnelStats(svc, 14);
  /* V3 clients only, by design: deposits are the target metric, and a
     (V1)/(V2.3) client's funnel doesn't even run the booking + deposit
     flow — every deposit rule would be noise about her. A client the
     sheet can't match stays in (24/25 are V3; new clients default V3). */
  const progRows = await fetchProgramRows(svc);
  const stats = allStats.filter((s) => {
    const p = findClientProgram(progRows, s.clientName);
    return !p || !p.version || p.version === "(V3)";
  });
  const slugs = stats.map((s) => s.slug);
  const [{ data: clientRows }, { data: existing }, days] = await Promise.all([
    svc.from("onebox_clients").select("slug, created_at").in("slug", slugs),
    svc.from("onebox_insights").select("slug, kind, status, decided_at").in("slug", slugs.length ? slugs : ["-"]),
    slotDays(origin, slugs),
  ]);
  const ageDays: Record<string, number> = {};
  for (const c of clientRows ?? []) {
    ageDays[c.slug as string] = Math.floor((Date.now() - new Date(c.created_at as string).getTime()) / 86400000);
  }
  const blocked = new Set<string>();
  for (const e of existing ?? []) {
    const key = `${e.slug}:${e.kind}`;
    if (e.status === "proposed") blocked.add(key);
    else if (e.decided_at && Date.now() - new Date(e.decided_at as string).getTime() < 21 * 86400000) blocked.add(key);
  }
  const proposals = runRules(stats, days, ageDays).filter((p) => !blocked.has(`${p.slug}:${p.kind}`));
  if (proposals.length) {
    await svc.from("onebox_insights").insert(proposals.map((p) => ({
      slug: p.slug, kind: p.kind, problem: p.problem, why: p.why, solution: p.solution, metrics: p.metrics,
    })));
  }
  const { count } = await svc.from("onebox_insights").select("id", { count: "exact", head: true }).eq("status", "proposed");
  return { created: proposals.length, open: count ?? 0, checked: stats.length };
}
