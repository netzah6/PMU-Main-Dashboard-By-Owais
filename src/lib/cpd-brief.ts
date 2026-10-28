import Anthropic from "@anthropic-ai/sdk";
import { createServiceClient } from "@/lib/supabase/server";
import { arrangeFeed, feedPosts, type IgFeed, type IgPicks, type PostKind } from "@/lib/ig-arrange";
import { reviewFunnelConfig } from "@/lib/funnel-checks";

/* Client brief for the Cost per Deposit dropdown (owner, 10/27/2026):
   "it's showing me a lot of info and it's hard to understand — I need it
   short and direct, then a recommendation based on your research and the
   data from all our V2.3 / V3 clients."

   Per client we gather the FACTS (spend, deposits, CPD, one-box funnel
   steps, AI engagement, call/text kills, funnel setup, Instagram first
   row, Google reviews, recent actions) and compare them with the fleet's
   medians for the same version. Deterministic RULES (the research below)
   turn those into candidate issues. Claude then writes the brief: a
   status, one headline, up to three plain lines on what's going on, and up
   to three ranked actions with the expected gain and who does it. If the
   model call fails the brief is built from the rules alone, so the panel
   never goes blank.

   Research the rules come from (memory files, all 2026):
   - version: V3 (AI follow-up) 5.5% deposits per lead vs V2.3 1.8% (3×)
   - deposits are decided at the PAYMENT step; lead→picked is near-flat
     across winners and losers (a vanity metric)
   - price $350–449 closes 11.6% of picks, >$450 collapses to 2.9%
   - "$150 OFF" ≥ "$200 OFF" (11.4 vs 9.5%); dollar-off beats free consult
   - dressed funnel (services ≥4, Instagram feed, photos, hours): 65% pick
     a time vs 52%
   - Instagram: a flyer/selfie in the first row costs ~⅓ of deposits (V3
     4.3% vs 6.0%; more in V2.3); work-first adds ~+7 pts picks only
   - artist calls that drop the lead out of the AI: 7.5% of leads fleet-wide
   - artist texts switch the AI off for that lead for good (Kill Text)
   - AI audit: deposit never asked in 75% of booked threads; price question
     answered next message only 22% of the time; reply speed is fine
   - follow-ups: 87% of deposits land by day 1, 96% by day 5
   - calendar: Thu–Sat carry the week; 1.5–2× open-slot coverage; 10+ open
     slots/day reads "not in demand" → Look Busy 60–70%
   - funnels younger than 3 weeks are not judgeable
   - first-timers (69% of leads) pay 6.2% of picks vs 10.5% for repeat PMU */

type Svc = ReturnType<typeof createServiceClient>;
const MODEL = "claude-opus-5-5";
const PAID = new Set(["booked", "paid", "paid-not-booked", "paid-followup"]);
export const STALE_HOURS = 20;
const CLOSURE = /\bstop\b|not interested|no longer|already (did|done|booked)|wrong number|no thanks|unsubscribe|going to pass/i;
// A lead's last text that actually needs an answer: a question or buying
// intent — not an "Ok thank you", an iMessage reaction ("Loved “…”") or a
// goodbye. Sampled 10/27/2026: 459 unanswered last-inbound texts fleet-wide,
// ~¾ were acks/reactions; ~100 were real questions (price, when, where).
const REACTION = /^\s*(loved|liked|laughed at|emphasized|questioned|disliked|le encantó|le gustó)\s+[“"]/i;
const ACK = /^\s*(ok(ay)?|k|yes|yeah|yep|sure|thanks?( you)?( so much)?|ty|perfect|great|sounds good|got it|will do|awesome|alright|you too|no problem|np|i will|same to you|bye)[\s!.,👍🏾🏻🏼🏽🏿❤️🙏😊🥰👌😁🙂]*$/i;
const INTENT = /\?|price|cost|how much|charge|\$|when|what time|where|address|book|appointment|availab|deposit|schedule|call me|interested|how (do|long|soon)|can i|do you/i;
const needsReply = (b: string) => !!b && !REACTION.test(b) && !ACK.test(b) && !CLOSURE.test(b) && INTENT.test(b);

export type Who = "us" | "client" | "owner";
export type BriefAction = { title: string; why: string; gain: string; who: Who; code: string };
export type Issue = { code: string; severity: "fix" | "watch" | "good"; title: string; detail: string; gain?: string; who: Who };
export type FleetStats = { version: string; clients: number; pickRate: number | null; payOfPick: number | null; payOfLead: number | null; cpd30: number | null; cpl30: number | null; deposits30: number | null; engagedPct: number | null };
export type Facts = {
  name: string; business: string; version: string; status: string; coach: string | null;
  funnelAgeDays: number | null;
  budget: number | null; spent7: number; spent14: number; spent30: number;
  deposits7: number; deposits14: number; deposits30: number; depositsPrev14: number;
  cpd14: number | null; cpd30: number | null;
  sheetLeads7: number; sheetLeads14: number; sheetLeads30: number; cpl30: number | null;
  onebox: { leads30: number; picked30: number; paid30: number; leads14: number; picked14: number; paid14: number; pickRate30: number | null; payOfPick30: number | null; payOfLead30: number | null } | null;
  ai: { leads: number; engagedPct: number | null; offerPct: number | null; aiOffPct: number | null; hotWaiting: number } | null;
  kills: { callPct: number | null; callDead: number; callQualified: number; callFixedAt: string | null; textPct: number | null; textDead: number; textQualified: number };
  setup: { price: number | null; offer: string; servicesCount: number; photoCount: number; hasHours: boolean; canCharge: boolean; hasInstagram: boolean; igShown: boolean; igFirstRow: PostKind[]; igWorkTiles: number; igTiles: number; reviewsRating: number | null; reviewsCount: number | null; checks: { code: string; severity: string; title: string }[] };
  recentActions: { date: string; note: string }[];
  fleet: FleetStats;
};
export type Brief = {
  slug: string; owner_key: string; status: "good" | "watch" | "fix"; headline: string; situation: string[]; actions: BriefAction[]; watch: string | null;
  issues: Issue[]; facts: Facts; model: string | null; computed_at: string;
};

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const pct = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const median = (xs: number[]): number | null => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const normVersion = (v: unknown): string => {
  const s = String(v ?? "").toUpperCase();
  if (s.includes("V3")) return "V3";
  if (s.includes("V2.3") || s.includes("V2")) return "V2.3";
  if (s.includes("V1")) return "V1";
  return s.replace(/[()]/g, "").trim() || "?";
};
const isTest = (name: unknown) => /test/i.test(String(name ?? ""));
const disqualified = (answers: Record<string, unknown> | null): boolean => {
  const a = answers ?? {};
  return !!a.disqualified || String(a.seriousness ?? "") === "0-2" || String(a.commutable ?? "") === "No";
};

async function allRows<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

type OverviewRow = Record<string, unknown> & { owner_name: string | null; version: string | null; client_status: string | null };
type OneboxRow = { slug: string; location_id: string | null; client_name: string | null; status: string; config: Record<string, string> | null; extras: Record<string, unknown> | null; created_at: string | null };
type LeadRow = { slug: string; ghl_status: string; picked_time_at: string | null; created_at: string; answers: Record<string, unknown> | null; full_name: string | null };
type StatusRow = { owner_key: string; location_id: string | null; status: string; offer_made: boolean | null; ai_off: boolean | null; last_message_direction: string | null; last_message_body: string | null; activity_date: string | null };

/** Everything the fleet needs, loaded once per run. */
async function loadFleet(svc: Svc) {
  const since30 = new Date(Date.now() - 30 * 86400_000).toISOString();
  const since45 = new Date(Date.now() - 45 * 86400_000).toISOString();
  const [ov, act, ob, leads, statuses, ck, tk, kf, acts] = await Promise.all([
    svc.from("deposit_overview").select("*").then((r) => (r.data ?? []) as OverviewRow[]),
    svc.from("onebox_active_clients").select("owner_name, business_name, slug, onebox_status").then((r) => (r.data ?? []) as { owner_name: string; business_name: string | null; slug: string; onebox_status: string | null }[]),
    svc.from("onebox_clients").select("slug, location_id, client_name, status, config, extras, created_at").then((r) => (r.data ?? []) as OneboxRow[]),
    allRows<LeadRow>((f, t) => svc.from("onebox_leads").select("slug, ghl_status, picked_time_at, created_at, answers, full_name").gte("created_at", since30).range(f, t)),
    allRows<StatusRow>((f, t) => svc.from("ghl_lead_status").select("owner_key, location_id, status, offer_made, ai_off, last_message_direction, last_message_body, activity_date").gte("date_added", since30).range(f, t)),
    svc.from("call_kill_stats").select("slug, qualified, dead").then((r) => (r.data ?? []) as { slug: string; qualified: number; dead: number }[]),
    svc.from("text_kill_stats").select("slug, qualified, dead").then((r) => (r.data ?? []) as { slug: string; qualified: number; dead: number }[]),
    svc.from("call_kill_fixes").select("owner_key, fixed, fixed_at").then((r) => (r.data ?? []) as { owner_key: string; fixed: boolean; fixed_at: string | null }[]),
    svc.from("client_activity").select("client_key, action_date, note, created_by").gte("action_date", since45.slice(0, 10)).not("created_by", "is", null).order("action_date", { ascending: false }).then((r) => (r.data ?? []) as { client_key: string; action_date: string; note: string | null }[]),
  ]);
  return { ov, act, ob, leads, statuses, ck, tk, kf, acts };
}
type Fleet = Awaited<ReturnType<typeof loadFleet>>;

function clientFacts(fl: Fleet, row: OverviewRow, slug: string | null, fleetByVersion: Map<string, FleetStats>): Facts {
  const ownerKey = String(row.owner_name ?? "").toLowerCase().trim();
  const version = normVersion(row.version);
  const obRow = slug ? fl.ob.find((o) => o.slug === slug) ?? null : null;
  const cfg = (obRow?.config ?? {}) as Record<string, string>;
  const extras = (obRow?.extras ?? {}) as Record<string, unknown>;
  const ageDays = obRow?.created_at ? Math.floor((Date.now() - new Date(obRow.created_at).getTime()) / 86400_000) : null;

  // One-box funnel steps, qualified leads only (same population as the Kill columns).
  const cut14 = Date.now() - 14 * 86400_000;
  let onebox: Facts["onebox"] = null;
  if (slug) {
    const ls = fl.leads.filter((l) => l.slug === slug && !disqualified(l.answers) && !isTest(l.full_name));
    const paid = (l: LeadRow) => PAID.has(l.ghl_status);
    const picked = (l: LeadRow) => !!l.picked_time_at || paid(l);
    const l14 = ls.filter((l) => new Date(l.created_at).getTime() >= cut14);
    const leads30 = ls.length, picked30 = ls.filter(picked).length, paid30 = ls.filter(paid).length;
    onebox = {
      leads30, picked30, paid30,
      leads14: l14.length, picked14: l14.filter(picked).length, paid14: l14.filter(paid).length,
      pickRate30: pct(picked30, leads30), payOfPick30: pct(paid30, picked30), payOfLead30: pct(paid30, leads30),
    };
  }

  // AI side (GHL lead status, V3 only — V2.3 has no CloseBot).
  let ai: Facts["ai"] = null;
  if (version === "V3") {
    // By sub-account first: owner names in the GHL sync go stale on recycled
    // sub-accounts (same trap as the Kill columns, PR #1045).
    const loc = obRow?.location_id ?? null;
    const st = fl.statuses.filter((s) => (loc ? s.location_id === loc : s.owner_key === ownerKey));
    const engaged = st.filter((s) => s.status !== "v3_only").length;
    // Waiting = the lead wrote last, 2h–7d ago, nobody answered, and it
    // wasn't a goodbye (STOP / not interested). Older than a week it's a
    // lost lead, not a "reply today" item.
    const twoH = Date.now() - 2 * 3600_000, week = Date.now() - 7 * 86400_000;
    const hot = st.filter((s) => {
      if (s.last_message_direction !== "inbound" || s.status === "confirmed" || !s.activity_date) return false;
      const t = new Date(s.activity_date).getTime();
      return t < twoH && t >= week && needsReply(String(s.last_message_body ?? ""));
    }).length;
    ai = {
      leads: st.length,
      engagedPct: pct(engaged, st.length),
      offerPct: pct(st.filter((s) => !!s.offer_made).length, st.length),
      aiOffPct: pct(st.filter((s) => !!s.ai_off).length, st.length),
      hotWaiting: hot,
    };
  }

  const ck = slug ? fl.ck.find((k) => k.slug === slug) : undefined;
  const tk = slug ? fl.tk.find((k) => k.slug === slug) : undefined;
  const kfix = fl.kf.find((k) => k.owner_key.toLowerCase().trim() === ownerKey && k.fixed);
  const kills: Facts["kills"] = {
    callPct: ck && ck.qualified > 0 ? pct(ck.dead, ck.qualified) : null, callDead: ck?.dead ?? 0, callQualified: ck?.qualified ?? 0, callFixedAt: kfix?.fixed_at ?? null,
    textPct: tk && tk.qualified > 0 ? pct(tk.dead, tk.qualified) : null, textDead: tk?.dead ?? 0, textQualified: tk?.qualified ?? 0,
  };

  // Instagram grid as the funnel shows it (first row = what a lead sees first).
  const feed = extras.igFeed as IgFeed | undefined;
  const tiles = feed ? feedPosts(arrangeFeed(feed, extras.igPicks as IgPicks | undefined)).slice(0, 6) : [];
  const igShown = tiles.length >= 3 && !extras.igWidgetOff;
  const firstRow = tiles.slice(0, 3).map((p) => p.kind).filter((k): k is PostKind => !!k);
  const workTiles = tiles.filter((p) => p.kind === "split_ba" || p.kind === "after_closeup" || p.kind === "during" || (p.kind === "other" && p.pmu)).length;
  const gr = extras.gReviews as { rating?: number; count?: number } | undefined;
  const review = reviewFunnelConfig({ cfg, extras, ageDays, hasIgFeed: igShown, priceApplies: version === "V3" });

  const d14 = num(row.d14), d30 = num(row.d30);
  return {
    name: String(row.owner_name ?? ""), business: String(obRow?.client_name ?? row.ad_account_name ?? ""), version, status: String(row.client_status ?? ""), coach: (row.assigned as string | null) ?? null,
    funnelAgeDays: ageDays,
    budget: row.daily_budget == null ? null : num(row.daily_budget), spent7: num(row.spent7), spent14: num(row.spent14), spent30: num(row.spent30),
    deposits7: num(row.d7), deposits14: d14, deposits30: d30, depositsPrev14: Math.max(0, d30 - d14),
    cpd14: row.cpd14 == null ? null : num(row.cpd14), cpd30: row.cpd30 == null ? null : num(row.cpd30),
    sheetLeads7: num(row.l7), sheetLeads14: num(row.l14), sheetLeads30: num(row.l30), cpl30: num(row.l30) > 0 ? Math.round((num(row.spent30) / num(row.l30)) * 100) / 100 : null,
    onebox, ai, kills,
    setup: {
      price: review.config.price, offer: review.config.offer, servicesCount: review.config.servicesCount, photoCount: review.config.photoCount, hasHours: review.config.businessHours, canCharge: review.config.canCharge,
      hasInstagram: review.config.igWidget, igShown, igFirstRow: firstRow, igWorkTiles: workTiles, igTiles: tiles.length,
      reviewsRating: gr?.rating ?? null, reviewsCount: gr?.count ?? null,
      checks: review.checks.map((c) => ({ code: c.code, severity: c.severity, title: c.title })),
    },
    recentActions: fl.acts.filter((a) => a.client_key.toLowerCase().trim() === ownerKey).slice(0, 5).map((a) => ({ date: a.action_date, note: String(a.note ?? "").slice(0, 160) })),
    fleet: fleetByVersion.get(version) ?? { version, clients: 0, pickRate: null, payOfPick: null, payOfLead: null, cpd30: null, cpl30: null, deposits30: null, engagedPct: null },
  };
}

/** Medians per version over LIVE clients with ≥20 qualified one-box leads (30d). */
function fleetBenchmarks(fl: Fleet, slugOf: Map<string, string>): Map<string, FleetStats> {
  const by = new Map<string, { pick: number[]; pay: number[]; payLead: number[]; cpd: number[]; cpl: number[]; dep: number[]; eng: number[] }>();
  for (const row of fl.ov) {
    if (String(row.client_status ?? "").toLowerCase() !== "live") continue;
    const ownerKey = String(row.owner_name ?? "").toLowerCase().trim();
    const slug = slugOf.get(ownerKey);
    if (!slug) continue;
    const ls = fl.leads.filter((l) => l.slug === slug && !disqualified(l.answers) && !isTest(l.full_name));
    if (ls.length < 20) continue;
    const v = normVersion(row.version);
    const b = by.get(v) ?? { pick: [], pay: [], payLead: [], cpd: [], cpl: [], dep: [], eng: [] };
    const paid = ls.filter((l) => PAID.has(l.ghl_status)).length;
    const picked = ls.filter((l) => !!l.picked_time_at || PAID.has(l.ghl_status)).length;
    b.pick.push(picked / ls.length);
    if (picked > 0) b.pay.push(paid / picked);
    b.payLead.push(paid / ls.length);
    if (row.cpd30 != null && num(row.cpd30) > 0) b.cpd.push(num(row.cpd30));
    if (num(row.l30) > 0 && num(row.spent30) > 0) b.cpl.push(num(row.spent30) / num(row.l30));
    b.dep.push(num(row.d30));
    if (v === "V3") {
      const loc = fl.ob.find((o) => o.slug === slug)?.location_id ?? null;
      const st = fl.statuses.filter((s) => (loc ? s.location_id === loc : s.owner_key === ownerKey));
      if (st.length >= 20) b.eng.push(st.filter((s) => s.status !== "v3_only").length / st.length);
    }
    by.set(v, b);
  }
  const out = new Map<string, FleetStats>();
  for (const [v, b] of by) {
    const p = (m: number | null) => (m == null ? null : Math.round(m * 1000) / 10);
    out.set(v, { version: v, clients: b.pick.length, pickRate: p(median(b.pick)), payOfPick: p(median(b.pay)), payOfLead: p(median(b.payLead)), cpd30: median(b.cpd) == null ? null : Math.round(median(b.cpd) as number), cpl30: median(b.cpl) == null ? null : Math.round((median(b.cpl) as number) * 100) / 100, deposits30: median(b.dep), engagedPct: p(median(b.eng)) });
  }
  return out;
}

/* ── The rules ─────────────────────────────────────────────────────────── */
export function findIssues(f: Facts): Issue[] {
  const out: Issue[] = [];
  const ob = f.onebox;
  const fleet = f.fleet;
  const young = f.funnelAgeDays != null && f.funnelAgeDays < 21;
  const perMonth = (dead14: number) => {
    const rate = Math.max(ob?.payOfLead30 ?? 0, fleet.payOfLead ?? 0) / 100;
    const n = dead14 * 2 * rate * 1.5; // killed leads had already engaged → above-average intent
    return n >= 0.75 ? `≈ +${Math.max(1, Math.round(n))} deposits/mo` : "small (few leads affected)";
  };

  if (!f.setup.canCharge && f.version === "V3") out.push({ code: "cant_charge", severity: "fix", who: "us", title: "The deposit page can't charge", detail: "No Fanbasis product on the funnel — every lead who picks a time hits a dead checkout.", gain: "all deposits" });

  const adsOff = f.budget != null && f.budget > 0 && f.spent7 < f.budget && f.sheetLeads7 === 0;
  if (adsOff) out.push({ code: "ads_off", severity: "fix", who: "us", title: "Ads aren't delivering", detail: `Budget $${f.budget}/day but only $${Math.round(f.spent7)} spent and 0 leads in 7 days. Check the campaign (paused, rejected ad, billing).`, gain: "all deposits" });

  if (young) out.push({ code: "young_funnel", severity: "watch", who: "us", title: `Funnel is ${f.funnelAgeDays} days old — too early to judge`, detail: "Every funnel took 2–3 weeks before deposits ramped. Don't touch price or offer yet; make sure the setup is complete." });

  const leads30 = ob?.leads30 ?? f.sheetLeads30;
  if (!young && !adsOff && leads30 < 20 && f.budget != null && f.budget > 0) {
    if (f.cpl30 != null && fleet.cpl30 != null && f.cpl30 > fleet.cpl30 * 1.6) out.push({ code: "cpl_high", severity: "fix", who: "us", title: "Leads cost too much", detail: `$${f.cpl30} per lead vs $${fleet.cpl30} ${fleet.version} median — audience or creative problem, not the funnel.`, gain: "more leads for the same money" });
    else out.push({ code: "low_volume", severity: "watch", who: "owner", title: "Too few leads to convert", detail: `${leads30} leads in 30 days at $${f.budget}/day. Below ~20 leads/month nothing else can move the needle — budget or audience first.` });
  }

  if (f.version === "V2.3") out.push({ code: "v23", severity: "watch", who: "owner", title: "No AI follow-up (V2.3)", detail: `V3 clients turn ${fleet.payOfLead != null ? "" : ""}~3× more leads into deposits (5.5% vs 1.8% per lead) because the AI chases the deposit after the page. Upgrade when possible.`, gain: "up to 3× deposits per lead" });

  if (!young && f.deposits30 === 0 && f.spent30 >= 200 && !adsOff) out.push({ code: "no_deposits", severity: "fix", who: "us", title: "Zero deposits in 30 days", detail: `$${Math.round(f.spent30)} spent, ${leads30} leads, nobody paid. Walk the checkout as a lead and read the last 10 conversations.`, gain: "first deposits" });

  if (f.kills.callPct != null && f.kills.callPct >= 7 && f.kills.callDead >= 2) out.push({ code: "call_kill", severity: "fix", who: "us", title: `Artist calls switch the AI off (${f.kills.callPct}% of leads)`, detail: `${f.kills.callDead} of ${f.kills.callQualified} leads lost all follow-ups after a call in 14 days${f.kills.callFixedAt ? " — marked fixed on " + f.kills.callFixedAt.slice(5, 10).replace("-", "/") + " but still happening: check the 'Stop follow ups' workflow is Draft" : ": fix the call workflow (remove the un-enroll step)"}.`, gain: perMonth(f.kills.callDead) });
  if (f.kills.textPct != null && f.kills.textPct >= 7 && f.kills.textDead >= 2) out.push({ code: "text_kill", severity: "fix", who: "client", title: `She texts leads herself and kills the AI (${f.kills.textPct}% of leads)`, detail: `${f.kills.textDead} of ${f.kills.textQualified} leads lost the AI after her own text in 14 days. Send the "Please let the AI work" snippet with her numbers.`, gain: perMonth(f.kills.textDead) });

  if (f.ai && f.ai.hotWaiting >= 2) out.push({ code: "hot_waiting", severity: "fix", who: "us", title: `${f.ai.hotWaiting} leads asked something and got no answer`, detail: "They asked a question (price, when, where…) within the past week and nobody replied for 2h+. Answer them today — the warmest leads in the account.", gain: "same-week deposits" });

  for (const c of f.setup.checks) {
    if (c.code === "cant_charge" || c.code === "young_funnel" || c.code === "setup_ok") continue;
    const who: Who = c.code === "price_cliff" || c.code === "discount_too_big" ? "owner" : "us";
    const sev: Issue["severity"] = c.severity === "fix" ? "fix" : c.severity === "good" ? "good" : "watch";
    const detail =
      c.code === "price_cliff" ? "Over $450 only 2.9% of picks pay vs 11.6% in the $350–449 band (winner $397). The client decides — present the numbers." :
      c.code === "no_price" ? "V3 funnels that show the strike-through price close 2.2× more (9.8% vs 4.4%). Fill Original + Discounted price." :
      c.code === "free_consult_no_price" ? "Free-consult with a blank price is the losing combo (4.8%). Fill the price or switch to \"$150 OFF\"." :
      c.code === "offer_wording" ? `Offer is “${f.setup.offer}”. Dollar-off wording closes best ($150 OFF 11.4% vs free consult 6.9%).` :
      c.code === "discount_too_big" ? "\"$150 OFF\" closes as well as bigger discounts (11.4% vs 9.5% for $200 OFF)." :
      c.code === "bare_funnel" ? c.title.replace(/^Bare funnel — /, "") + ". Dressed funnels get 65% of leads to pick a time vs 52%." :
      c.title;
    out.push({ code: c.code, severity: sev, who, title: c.code === "bare_funnel" ? "Funnel page is missing pieces" : c.title.replace(/ — .*$/, ""), detail, gain: c.code === "bare_funnel" ? "≈ +13 pts of leads picking a time" : c.code === "price_cliff" ? "up to 4× pay-through" : undefined });
  }

  if (f.setup.igShown && f.setup.igFirstRow.some((k) => k === "flyer_text" || k === "person")) out.push({ code: "ig_first_row", severity: "fix", who: "us", title: "Instagram first row shows a flyer or selfie", detail: "Leads see it before the booking button. Feeds with a flyer/selfie first turn ~⅓ fewer picks into deposits (V3 4.3% vs 6.0%). Open the grid panel and Put first a clean result photo.", gain: `≈ +${Math.max(1, Math.round((ob?.paid30 ?? 0) * 0.3))} deposits/mo` });
  else if (!f.setup.igShown && f.setup.hasInstagram) out.push({ code: "ig_building", severity: "watch", who: "us", title: "Instagram grid not on the funnel yet", detail: "We have her Instagram link but the grid has under 3 usable posts or is switched off. Refresh it from the grid panel." });

  if (ob && !young) {
    if (ob.picked30 >= 25 && ob.payOfPick30 != null && fleet.payOfPick != null && ob.payOfPick30 < fleet.payOfPick * 0.6)
      out.push({ code: "pay_low", severity: "fix", who: "us", title: "Leads pick a time but don't pay", detail: `${ob.payOfPick30}% of the ${ob.picked30} who picked a time paid vs ${fleet.payOfPick}% ${fleet.version} median. The leak is at the payment step: ${f.version === "V3" ? "read 10 booked threads — is the deposit asked, is the price answered — and walk the checkout" : "walk the checkout; without AI the page must close on its own"}.`, gain: `≈ +${Math.max(1, Math.round(ob.picked30 * ((fleet.payOfPick - (ob.payOfPick30 ?? 0)) / 100)))} deposits/mo at fleet rate` });
    if (ob.leads30 >= 30 && ob.pickRate30 != null && ob.pickRate30 < 15)
      out.push({ code: "pick_none", severity: "fix", who: "us", title: "Almost nobody can pick a time", detail: `Only ${ob.picked30} of ${ob.leads30} leads picked a time (${ob.pickRate30}% vs ${fleet.pickRate ?? 60}% median). Usually the calendar shows no openings (hours/slots/sync) — open the funnel as a lead and check what times it offers.`, gain: "all deposits" });
    else if (ob.leads30 >= 30 && ob.pickRate30 != null && fleet.pickRate != null && ob.pickRate30 < fleet.pickRate * 0.75)
      out.push({ code: "pick_low", severity: "watch", who: "us", title: "Few leads pick a time", detail: `${ob.pickRate30}% of ${ob.leads30} leads picked a time vs ${fleet.pickRate}% median. Usually the page (missing pieces, Instagram first row) or Thu–Sat hours — check the calendar card.` });
  }
  if (f.ai && f.ai.leads >= 30) {
    if (f.ai.engagedPct != null && fleet.engagedPct != null && f.ai.engagedPct < fleet.engagedPct * 0.7) out.push({ code: "engaged_low", severity: "watch", who: "us", title: "Most leads never answer the AI", detail: `${f.ai.engagedPct}% engaged vs ${fleet.engagedPct}% ${fleet.version} median. Check the first text goes out (survey trigger) and the audience quality.` });
    if (f.ai.aiOffPct != null && f.ai.aiOffPct >= 25) out.push({ code: "ai_off_high", severity: "watch", who: "us", title: `AI switched off on ${f.ai.aiOffPct}% of leads`, detail: "Manual texts, calls or the handoff leak turn the AI off; those leads get no follow-ups. See Kill Call / Kill Text." });
  }

  if (!young && f.depositsPrev14 >= 4 && f.deposits14 <= f.depositsPrev14 * 0.5 && f.spent14 >= (f.spent30 - f.spent14) * 0.7)
    out.push({ code: "deposits_drop", severity: "watch", who: "us", title: "Deposits halved vs the previous two weeks", detail: `${f.deposits14} vs ${f.depositsPrev14} on similar spend. Look at what changed around ${new Date(Date.now() - 14 * 86400_000).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit" })}: ads, calendar, a manual-text habit, the offer.` });

  const healthyPay = ob?.payOfPick30 != null && fleet.payOfPick != null && ob.payOfPick30 >= fleet.payOfPick;
  if (!young && f.cpd14 != null && fleet.cpd30 != null && f.cpd14 <= fleet.cpd30 * 0.7 && f.deposits14 >= 5 && healthyPay && !out.some((i) => i.severity === "fix"))
    out.push({ code: "scale", severity: "good", who: "owner", title: "Converting well — room to scale", detail: `$${Math.round(f.cpd14)} per deposit vs $${fleet.cpd30} ${fleet.version} median with a healthy pay rate. Propose +$5–10/day (the "Increase Budget" snippet).`, gain: "more deposits at the same CPD" });

  if (!out.some((i) => i.severity !== "good")) out.push({ code: "healthy", severity: "good", who: "us", title: "No leak found", detail: "Setup, kills, pay-through and lead flow all look normal for this version. Keep the current setup." });
  return out;
}

export function statusOf(issues: Issue[]): Brief["status"] {
  if (issues.some((i) => i.severity === "fix")) return "fix";
  if (issues.some((i) => i.severity === "watch" && i.code !== "young_funnel")) return "watch";
  return "good";
}

/* ── Fallback wording (no model) ───────────────────────────────────────── */
function ruleBrief(f: Facts, issues: Issue[]): Pick<Brief, "status" | "headline" | "situation" | "actions" | "watch"> {
  const top = issues.filter((i) => i.severity !== "good").slice(0, 3);
  const money = f.deposits14 > 0 && f.cpd14 != null ? `$${Math.round(f.cpd14)} per deposit, ${f.deposits14} deposits in 14 days` : `${f.deposits14} deposits in 14 days on $${Math.round(f.spent14)}`;
  const vs = f.fleet.cpd30 != null ? ` (${f.fleet.version} median $${f.fleet.cpd30})` : "";
  return {
    status: statusOf(issues),
    headline: top[0]?.title ?? (issues[0]?.title ?? "Looks healthy"),
    situation: [money + vs, ...(f.onebox ? [`${f.onebox.leads30} leads → ${f.onebox.pickRate30 ?? 0}% picked a time → ${f.onebox.payOfPick30 ?? 0}% of those paid (median ${f.fleet.payOfPick ?? "?"}%)`] : [])].slice(0, 3),
    actions: (top.length ? top : issues.slice(0, 1)).map((i) => ({ title: i.title, why: i.detail, gain: i.gain ?? "unclear", who: i.who, code: i.code })),
    watch: null,
  };
}

/* ── The model write-up ────────────────────────────────────────────────── */
const SYSTEM = `You write the one-screen brief a PMU (permanent-makeup) marketing agency's owner reads for each client on the Cost per Deposit tab. The agency runs Facebook ads to a one-box funnel (lead form → pick a time → $50 deposit checkout) and, for V3 clients, an AI assistant that chats and chases the deposit by text. V2.3 clients have template texts, no AI.

You get FACTS (this client vs the median of the fleet's clients on the same version) and ISSUES found by the agency's own research rules. Write for someone reading on a phone: plain words, no jargon, short.

Research you may lean on (2026 fleet studies):
- Deposits are decided at the payment step. Lead→picked-a-time is nearly flat between winners and losers; don't celebrate it.
- V3 (AI) 5.5% deposits per lead vs V2.3 1.8%.
- Price $350–449 closes 11.6% of picks; over $450 collapses to 2.9%. "$150 OFF" beats bigger discounts; dollar-off beats free consult.
- Dressed funnel (4+ services, Instagram feed, photos, hours): 65% pick a time vs 52%.
- Instagram: a flyer/selfie in the first row costs ~⅓ of deposits; a clean feed only adds picks.
- Artist calls drop leads out of the AI (fixable workflow); artist texts switch the AI off for good.
- AI audit: deposit never asked in 75% of booked threads; price question answered next message only 22%; reply speed is fine.
- 87% of deposits land within a day of the lead, 96% by day 5.
- Thu–Sat carry the week's deposits; Mon–Wed are naturally quiet.
- Under 20 leads/month nothing downstream matters; under 3 weeks old nothing is judgeable.

Rules for the brief:
- Use ONLY numbers given in FACTS. Never invent data. If "ai" is null or ai.leads is 0, the AI stats are unavailable — don't mention them. Say "too few leads to tell" when counts are small (<20 leads, <5 deposits).
- status: "fix" if something is actively losing deposits, "watch" if something should be checked or decided, "good" otherwise.
- headline: ≤ 12 words, the single most important thing, plain.
- situation: 1–3 lines, each ≤ 18 words, each with a number and the fleet comparison where useful. First line = money (deposits, $ per deposit vs median).
- actions: 1–3, ranked by deposits gained, drawn from ISSUES (keep their "code"). title ≤ 8 words imperative; why ≤ 22 words with the data; gain = the issue's gain or a careful estimate or "unclear"; who = "us" (agency does it), "client" (the artist must act), "owner" (a decision: price, budget, version).
- If recent actions are listed, mention in situation whether deposits moved after the latest one (only from FACTS: deposits14 vs depositsPrev14).
- Don't recommend things the owner has ruled out: no card-on-file, no automatic AI re-enable, no A/B tests here, no price changes for a client who chose a high price (present the numbers, "owner" decides).
- watch: one optional line, ≤ 16 words: what to re-check and when, or null.

Reply with JSON only:
{"status":"fix|watch|good","headline":"…","situation":["…"],"actions":[{"title":"…","why":"…","gain":"…","who":"us|client|owner","code":"…"}],"watch":"…"|null}`;

async function writeBrief(client: Anthropic, f: Facts, issues: Issue[]): Promise<(Pick<Brief, "status" | "headline" | "situation" | "actions" | "watch"> & { model: string }) | null> {
  const facts = { ...f, setup: { ...f.setup, checks: undefined } };
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 6000,
      system: SYSTEM,
      messages: [{ role: "user", content: `FACTS:\n${JSON.stringify(facts)}\n\nISSUES (research rules, roughly in priority order):\n${JSON.stringify(issues)}\n\nWrite the brief. JSON only.` }],
      ...({ thinking: { type: "adaptive" }, output_config: { effort: "medium" } } as Record<string, unknown>),
    });
    if (res.stop_reason === "refusal") return null;
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]) as Partial<Pick<Brief, "status" | "headline" | "situation" | "actions" | "watch">>;
    const status = j.status === "fix" || j.status === "watch" || j.status === "good" ? j.status : statusOf(issues);
    const actions = (Array.isArray(j.actions) ? j.actions : []).slice(0, 3).map((a) => ({
      title: String(a?.title ?? "").slice(0, 80), why: String(a?.why ?? "").slice(0, 220), gain: String(a?.gain ?? "unclear").slice(0, 60),
      who: (a?.who === "client" || a?.who === "owner" ? a.who : "us") as Who, code: String(a?.code ?? "").slice(0, 40),
    })).filter((a) => a.title);
    if (!j.headline || !actions.length) return null;
    return {
      status, headline: String(j.headline).slice(0, 120),
      situation: (Array.isArray(j.situation) ? j.situation : []).map((s) => String(s).slice(0, 160)).filter(Boolean).slice(0, 3),
      actions, watch: j.watch ? String(j.watch).slice(0, 140) : null, model: MODEL,
    };
  } catch {
    return null;
  }
}

/* ── Orchestration ─────────────────────────────────────────────────────── */
export async function computeBriefs(svc: Svc, opts: { slug?: string; limit?: number; force?: boolean; deadlineMs?: number } = {}): Promise<{ eligible: number; computed: number; modelFailed: number; partial: boolean; fleet: Record<string, FleetStats> }> {
  const started = Date.now();
  const deadline = opts.deadlineMs ?? 255_000;
  const fl = await loadFleet(svc);
  const slugOf = new Map(fl.act.map((a) => [a.owner_name.toLowerCase().trim(), a.slug]));
  const fleetByVersion = fleetBenchmarks(fl, slugOf);

  // Live clients with a one-box, oldest brief first (never computed → first).
  const { data: existing } = await svc.from("cpd_briefs").select("slug, computed_at");
  const age = new Map((existing ?? []).map((b) => [b.slug as string, new Date(b.computed_at as string).getTime()]));
  const stale = Date.now() - STALE_HOURS * 3600_000;
  let targets = fl.ov
    .filter((r) => String(r.client_status ?? "").toLowerCase() === "live")
    .map((r) => ({ row: r, ownerKey: String(r.owner_name ?? "").toLowerCase().trim(), slug: slugOf.get(String(r.owner_name ?? "").toLowerCase().trim()) ?? null }))
    .filter((t) => !!t.slug) as { row: OverviewRow; ownerKey: string; slug: string }[];
  if (opts.slug) targets = targets.filter((t) => t.slug === opts.slug);
  else if (!opts.force) targets = targets.filter((t) => (age.get(t.slug) ?? 0) < stale);
  targets.sort((a, b) => (age.get(a.slug) ?? 0) - (age.get(b.slug) ?? 0));
  if (opts.limit) targets = targets.slice(0, opts.limit);

  const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
  let computed = 0, modelFailed = 0, partial = false;
  const queue = [...targets];
  const worker = async () => {
    for (;;) {
      const t = queue.shift();
      if (!t) return;
      if (Date.now() - started > deadline) { partial = true; return; }
      const facts = clientFacts(fl, t.row, t.slug, fleetByVersion);
      const issues = findIssues(facts);
      const written = anthropic ? await writeBrief(anthropic, facts, issues) : null;
      if (!written) modelFailed++;
      const brief = written ?? { ...ruleBrief(facts, issues), model: null };
      await svc.from("cpd_briefs").upsert({
        slug: t.slug, owner_key: t.ownerKey, status: brief.status, headline: brief.headline, situation: brief.situation, actions: brief.actions, watch: brief.watch,
        issues, facts, model: brief.model, computed_at: new Date().toISOString(),
      });
      computed++;
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return { eligible: targets.length, computed, modelFailed, partial, fleet: Object.fromEntries(fleetByVersion) };
}
