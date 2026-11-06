// Loads what the "every possible cause" list needs and fills it in on each fallen
// client's row (see fell-causes.ts for the rules). Server only.

import type { SupabaseClient } from "@supabase/supabase-js";
import { DEP_ASK_KEY, DEP_ASK_START } from "@/lib/dep-ask";
import { INTERNAL_FUNNELS as INTERNAL } from "@/lib/funnel-freeze-server";
import type { BoardRow, FreezeStatRow, Peak } from "@/lib/funnel-freeze";
import type { ChangeItem } from "@/lib/funnel-timeline";
import { addDays, pacificDay } from "@/lib/funnel-timeline-view";
import { fellCauses, fellWhy, peakEndDay, type BriefIssue, type CauseFacts, type CauseInput } from "@/lib/fell-causes";

type BriefRow = { slug: string; issues: BriefIssue[] | null; facts: (CauseFacts & { status?: string }) | null; computed_at: string | null };
type AdRow = { owner_name: string | null; client_status: string | null; campaign_status: string | null; campaign_paused: boolean | null; media_buyer: string | null; assigned: string | null; daily_budget: number | string | null; spent7: number | string | null };

/* A check-up older than this is not "today" any more: its lines say they can't check. */
const FRESH_MS = 36 * 3_600_000;
/* A paused test's end isn't saved, so one that started shortly before the best months may have run into them. */
const TEST_LOOKBACK_DAYS = 60;

const middle = (values: number[]) => { const v = [...values].sort((a, b) => a - b); return v.length >= 10 ? v[Math.floor(v.length / 2)] : null; };
const numberOrNull = (v: number | string | null) => { const n = Number(v); return v == null || !Number.isFinite(n) ? null : n; };

/* They read the daily check-up, the ad account, team notes, saved changes, split
   tests and the page's start day. If one of those reads fails, the card says so:
   a half-read list would call things fine that were never checked. */
export async function addFellCauses(svc: SupabaseClient, rows: BoardRow[], stats: FreezeStatRow[], now: Date, firstSave: string): Promise<void> {
  const fallen = rows.filter((r) => r.fell && r.peak);
  if (!fallen.length) return;
  const today = pacificDay(now);
  const slugs = fallen.map((r) => r.slug);
  const ownerKey = (r: BoardRow) => r.owner.toLowerCase().trim();
  /* A name with a quote can't go into the notes filter; that client gets no list. */
  const keyed = (r: BoardRow) => ownerKey(r) !== "" && !/["\\]/.test(ownerKey(r));
  const keys = Array.from(new Set(fallen.filter(keyed).map(ownerKey)));
  const firstEnd = fallen.map((r) => peakEndDay(r.peak as Peak)).sort()[0];
  const firstStart = fallen.map((r) => `${(r.peak as Peak).from}-01`).sort()[0];
  /* Newest first with a cap, so a long history can only lose its oldest rows. */
  const [briefs, adRows, noteRows, changeRows, testRows, pageRows, depAsk] = await Promise.all([
    svc.from("cpd_briefs").select("slug, issues, facts, computed_at"),
    svc.from("performance_overview").select("owner_name, client_status, campaign_status, campaign_paused, media_buyer, assigned, daily_budget, spent7"),
    keys.length
      ? svc.from("client_activity").select("client_key, action_date, note").in("client_key", keys).gte("action_date", firstStart)
        .not("created_by", "is", null).order("action_date", { ascending: false }).order("created_at", { ascending: false }).limit(1000)
      : Promise.resolve({ data: [], error: null }),
    svc.from("funnel_versions").select("slug, saved_at, changes").in("slug", slugs).gt("prev_id", 0).gt("saved_at", `${firstEnd}T00:00:00Z`)
      .order("saved_at", { ascending: false }).limit(1000),
    svc.from("onebox_experiments").select("slug, name, status, created_at").in("slug", slugs).gte("created_at", `${addDays(firstStart, -TEST_LOOKBACK_DAYS)}T00:00:00Z`)
      .order("created_at", { ascending: true }),
    svc.from("onebox_clients").select("slug, created_at").in("slug", slugs),
    svc.from("app_settings").select("value").eq("key", DEP_ASK_KEY).maybeSingle(),
  ]);
  const failed = briefs.error || adRows.error || noteRows.error || changeRows.error || testRows.error || pageRows.error || depAsk.error;
  if (failed) {
    for (const r of fallen) r.fellWhy = { text: "I couldn't load this client's check-up just now. Reload the page.", sure: "unknown" };
    return;
  }
  const briefList = (briefs.data ?? []) as BriefRow[];
  const fresh = (b: BriefRow | undefined) => !!b?.computed_at && now.getTime() - Date.parse(b.computed_at) <= FRESH_MS;
  const briefBySlug = new Map(briefList.map((b) => [b.slug, b]));
  const liveV3 = briefList.filter((b) => fresh(b) && (b.facts?.status ?? "").toLowerCase() === "live" && (b.facts?.version ?? "").toUpperCase() === "V3" && (b.facts?.ai?.leads ?? 0) >= 30);
  const fleetOfferPct = middle(liveV3.map((b) => b.facts?.ai?.offerPct).filter((n): n is number => n != null));
  const fleetAiOffPct = middle(liveV3.map((b) => b.facts?.ai?.aiOffPct).filter((n): n is number => n != null));
  /* An owner can have more than one row: the live one with a campaign status wins. */
  const adByOwner = new Map<string, AdRow>();
  const adScore = (a: AdRow) => ((a.client_status ?? "").toLowerCase() === "live" ? 2 : 0) + (a.campaign_status ? 1 : 0);
  for (const a of (adRows.data ?? []) as AdRow[]) {
    const key = String(a.owner_name ?? "").toLowerCase().trim();
    const had = adByOwner.get(key);
    if (key && (!had || adScore(a) > adScore(had))) adByOwner.set(key, a);
  }
  const notes = ((noteRows.data ?? []) as { client_key: string; action_date: string; note: string | null }[]).slice().reverse();
  const changes = ((changeRows.data ?? []) as { slug: string; saved_at: string; changes: ChangeItem[] | null }[]).slice().reverse();
  const tests = (testRows.data ?? []) as { slug: string; name: string | null; status: string; created_at: string }[];
  const pageStart = new Map(((pageRows.data ?? []) as { slug: string; created_at: string | null }[]).map((p) => [p.slug, p.created_at]));
  const depAskSlugs = ((depAsk.data?.value as { slugs?: string[] } | null)?.slugs) ?? [];
  /* One row per business: a client with two pages has the same numbers on both. */
  const seen = new Set<string>();
  const clients = stats.filter((s) => {
    if (!s.business || (s.client_status ?? "") !== "live" || s.template === "b2b" || INTERNAL.has(s.slug) || seen.has(s.business)) return false;
    seen.add(s.business);
    return true;
  });
  for (const r of fallen) {
    if (!keyed(r)) {
      r.fellWhy = { text: "I can't match this client to the team notes and the ad account: the owner name in the Clients sheet is empty or has a quote mark in it.", sure: "unknown" };
      continue;
    }
    const peak = r.peak as Peak;
    const start = `${peak.from}-01`;
    const end = peakEndDay(peak);
    const stat = stats.find((s) => s.slug === r.slug);
    const brief = briefBySlug.get(r.slug);
    const checkup = fresh(brief) ? brief : undefined;
    const ad = adByOwner.get(ownerKey(r));
    /* The same other clients then and now: live in both best months and today, and
       with deposits already recorded back then (same rule as the card's month bars). */
    const same = clients.filter((s) => s.business !== r.business && !(s.before_deposits === 0 && peak.from <= "2026-08")
      && (s.months[peak.from]?.l ?? 0) >= 15 && (s.months[peak.to]?.l ?? 0) >= 15 && s.leads30 >= 20);
    let payLink: CauseInput["payLink"] = stat?.deposit_url ? "ours" : "none";
    try { if (stat?.deposit_url && new URL(stat.deposit_url).hostname !== "book.pmu-care.com") payLink = "other"; } catch { payLink = "none"; }
    const made = pageStart.get(r.slug);
    const input: CauseInput = {
      today,
      peak,
      now: r.now,
      months: stat?.months ?? {},
      lastLead: r.lastLead,
      lastDeposit: r.lastDeposit,
      earlyDepositsMissing: (stat?.before_deposits ?? 0) === 0,
      version: r.version,
      frozen: !!r.frozen,
      freeBooking: r.freeBooking,
      payLink,
      issues: checkup?.issues ?? null,
      facts: checkup?.facts ?? null,
      fleetOfferPct,
      fleetAiOffPct,
      ads: ad ? { status: ad.campaign_status, paused: ad.campaign_paused, buyer: ad.media_buyer?.trim() || null, coach: ad.assigned?.trim() || null, budget: numberOrNull(ad.daily_budget), spent7: numberOrNull(ad.spent7) } : null,
      notes: notes.filter((n) => n.client_key === ownerKey(r) && n.action_date >= start && (n.note ?? "").trim()).map((n) => ({ date: n.action_date, note: String(n.note) })),
      changes: changes.filter((c) => c.slug === r.slug && pacificDay(new Date(c.saved_at)) > end && (c.changes ?? []).length)
        .map((c) => ({ day: pacificDay(new Date(c.saved_at)), items: c.changes as ChangeItem[] })),
      firstSave,
      pageStart: made ? pacificDay(new Date(made)) : null,
      tests: tests.filter((t) => t.slug === r.slug && pacificDay(new Date(t.created_at)) >= addDays(start, -TEST_LOOKBACK_DAYS))
        .map((t) => ({ name: t.name ?? "Split test", running: t.status === "running", from: pacificDay(new Date(t.created_at)) })),
      depAskSince: depAskSlugs.includes(r.slug) ? pacificDay(new Date(DEP_ASK_START)) : null,
      others: same.length >= 5 ? {
        clients: same.length,
        then: same.reduce((a, s) => ({ l: a.l + s.months[peak.from].l + s.months[peak.to].l, d: a.d + s.months[peak.from].d + s.months[peak.to].d }), { l: 0, d: 0 }),
        now: same.reduce((a, s) => ({ l: a.l + s.leads30, d: a.d + s.deposits30 }), { l: 0, d: 0 }),
      } : null,
    };
    r.fellCauses = fellCauses(input);
    r.fellWhy = fellWhy(r.fellCauses, r.now);
  }
}
