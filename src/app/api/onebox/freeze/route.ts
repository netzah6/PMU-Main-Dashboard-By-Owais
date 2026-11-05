import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { createServiceClient } from "@/lib/supabase/server";
import { fetchProgramRows, findClientProgram, isV1Label } from "@/lib/client-program";
import { ONEBOX_ENGINE_V } from "@/lib/onebox-engine";
import { INTERNAL_FUNNELS as INTERNAL, ensureEngineCopy, freezeBlockedReason } from "@/lib/funnel-freeze-server";
import { warmFunnel } from "@/lib/onebox-warm";
import { signLogoUrl } from "@/lib/logo-sign";
import { findGoBackSuggestions, runFunnelTimeline, type ChangeItem } from "@/lib/funnel-timeline";
import type { GoBackSuggestion } from "@/lib/funnel-timeline-view";
import { acceptFrozenDrift, frozenDrift, snapshotFunnelPage, type FrozenPage, type OneboxRow } from "@/lib/onebox-page";
import { adsHints, fellFromPeak, fellWhy, findPeak, monthKey, peakWindow, pickPeakVersion, type Board, type BoardRow, type BriefIssue, type Peak, type FreezeStatRow, type HistoryEntry } from "@/lib/funnel-freeze";

// The Freeze screen (/funnels/freeze), admins only.
//   GET                                   every funnel: stats, suggestion, frozen state
//   POST {slug, action:"freeze"}          keep this funnel on today's page
//   POST {slug, action:"unfreeze"}        back on the live page
//   POST {slug, action:"accept"}          take values edited since the freeze onto the frozen page
//   POST {slug, action:"restore"}         put back the page kept until the last Unfreeze
//   POST {slug, action:"decline"}         stop suggesting it
//   POST {slug, action:"undecline"}       suggest it again
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 300; // warmFunnel's pings run 150 s after the response

type FreezeRow = {
  slug: string;
  suggested_at: string | null;
  suggested_leads: number | null;
  suggested_deposits: number | null;
  declined_at: string | null;
  declined_note: string | null;
  frozen_by: string | null;
  frozen_leads: number | null;
  frozen_deposits: number | null;
  history: HistoryEntry[] | null;
  last_frozen: { engine: number; at: string | null; by: string | null; leads: number | null; deposits: number | null; page: FrozenPage | null } | null;
};

const MONTHS_SHOWN = 7;
/* The timeline's first save (11/04/2026 Pacific). No page from before it exists. */
const FIRST_SAVE = "2026-11-05T00:00:00Z";

async function loadStats(svc: ReturnType<typeof createServiceClient>): Promise<FreezeStatRow[]> {
  const { data, error } = await svc.rpc("funnel_freeze_stats");
  if (error) throw new Error(error.message);
  return (data ?? []) as FreezeStatRow[];
}

export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const svc = createServiceClient();
  let stats: FreezeStatRow[];
  try {
    stats = await loadStats(svc);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "stats failed" }, { status: 500 });
  }
  const [{ data: freezeRows, error: freezeError }, { data: frozenClients, error: frozenError }, programs] = await Promise.all([
    svc.from("funnel_freeze").select("*"),
    svc.from("onebox_clients").select("slug, config, frozen_page").not("frozen_engine", "is", null),
    fetchProgramRows(svc),
  ]);
  /* Never fall through on a failed read: the writes below would take every
     funnel for new and overwrite the saved "when suggested" numbers. */
  if (freezeError || frozenError) return NextResponse.json({ error: (freezeError ?? frozenError)?.message }, { status: 500 });
  const bySlug = new Map(((freezeRows ?? []) as FreezeRow[]).map((r) => [r.slug, r]));
  const driftBySlug = new Map(((frozenClients ?? []) as unknown as OneboxRow[]).map((c) => [c.slug, frozenDrift(c)]));
  const now = new Date();
  /* Suggestions are extra: the screen still opens, and says so, if they can't be worked out. */
  let suggestionsFailed = false;
  const suggestions = await findGoBackSuggestions(svc, stats, programs, now).catch(() => {
    suggestionsFailed = true;
    return new Map<string, GoBackSuggestion>();
  });
  const monthKeys = Array.from({ length: MONTHS_SHOWN }, (_, i) => monthKey(now, MONTHS_SHOWN - 1 - i));

  type FirstSeen = { slug: string; suggested_at: string; suggested_leads: number; suggested_deposits: number; updated_at: string };
  const firstSeen: FirstSeen[] = [];
  const stamp = now.toISOString();
  const rows: BoardRow[] = stats
    .filter((s) => s.template !== "b2b" && !INTERNAL.has(s.slug) && (s.status === "live" || s.frozen_engine != null))
    .map((s) => {
      const version = findClientProgram(programs, s.client_name)?.version ?? "";
      const f = bySlug.get(s.slug);
      const goBack = suggestions.get(s.slug) ?? null;
      /* The first time a client is suggested for a change, its rate is written down:
         that is the "when suggested" number the screen compares against later. */
      let suggested = f?.suggested_at ? { at: f.suggested_at, l: f.suggested_leads, d: f.suggested_deposits } : null;
      if (goBack && (!suggested || suggested.at < goBack.changeAt)) {
        suggested = { at: stamp, l: s.leads30, d: s.deposits30 };
        firstSeen.push({ slug: s.slug, suggested_at: stamp, suggested_leads: s.leads30, suggested_deposits: s.deposits30, updated_at: stamp });
      }
      const peak = findPeak(s.months, now);
      const fell = fellFromPeak(peak, s.leads30, s.deposits30, s.client_status);
      let payLinkElsewhere = false;
      try { payLinkElsewhere = !!s.deposit_url && new URL(s.deposit_url).hostname !== "book.pmu-care.com"; } catch { /* not a URL: nothing to warn about */ }
      return {
        slug: s.slug,
        business: s.business ?? s.client_name,
        owner: s.owner_name ?? "",
        matched: s.business != null,
        version,
        clientStatus: s.client_status ?? "",
        freeBooking: s.free_booking,
        payLinkElsewhere,
        months: monthKeys.map((m) => ({ m, l: s.months[m]?.l ?? 0, d: s.months[m]?.d ?? 0 })),
        before: { l: s.before_leads, d: s.before_deposits },
        now: { l: s.leads30, d: s.deposits30, picks: s.picks30, pageLeads: s.page_leads30 },
        lastLead: s.last_lead,
        goBack,
        peak,
        fell,
        fellHints: fell && peak ? adsHints(peak, s.leads30, s.last_lead, now) : [],
        fellWhy: null,
        peakPage: null,
        suggested,
        declined: f?.declined_at ? { at: f.declined_at, note: f.declined_note } : null,
        frozen: s.frozen_engine != null
          ? { engine: s.frozen_engine, at: s.frozen_at, by: f?.frozen_by ?? null, l: f?.frozen_leads ?? null, d: f?.frozen_deposits ?? null }
          : null,
        drift: driftBySlug.get(s.slug) ?? [],
        restorable: s.frozen_engine == null && f?.last_frozen?.page ? { at: f.last_frozen.at } : null,
        history: f?.history ?? [],
      };
    })
    /* (V1) funnels aren't shown (owner, 11/05/2026). Two stay: a frozen one, so it can be
       unfrozen, and one that fell from a good rate, because a (V1) label set by mistake
       removes the calendar and deposit steps (Tonni, 09/2026). */
    .filter((r) => !isV1Label(r.version) || r.frozen || r.fell);

  /* "See the page from its best months": only possible for months after pages
     started being saved, so today this reads nothing. */
  /* "Why I think it fell": from each fallen client's daily check-up. A missing
     check-up still gets a note, from the numbers alone. */
  const fallen = rows.filter((r) => r.fell && r.peak);
  if (fallen.length) {
    const { data: briefs } = await svc.from("cpd_briefs").select("slug, issues").in("slug", fallen.map((r) => r.slug));
    const issuesBySlug = new Map(((briefs ?? []) as { slug: string; issues: BriefIssue[] | null }[]).map((b) => [b.slug, b.issues]));
    for (const r of fallen) r.fellWhy = fellWhy(issuesBySlug.get(r.slug) ?? null, r.peak as Peak, r.now, r.fellHints);
  }

  const wanting = rows.filter((r) => r.fell && r.peak && peakWindow(r.peak).end > FIRST_SAVE);
  if (wanting.length) {
    const [copies, ...lists] = await Promise.all([
      svc.from("onebox_engine_copies").select("version"),
      ...wanting.map((r) => svc.from("funnel_versions").select("id, saved_at, engine, changes").eq("slug", r.slug)
        .order("saved_at", { ascending: false }).order("id", { ascending: false }).limit(300)),
    ]);
    const saved = new Set(((copies.data ?? []) as { version: number }[]).map((c) => c.version));
    wanting.forEach((r, i) => {
      const { start, end } = peakWindow(r.peak as Peak);
      const hit = pickPeakVersion((lists[i].data ?? []) as { id: number; saved_at: string; engine: number; changes: ChangeItem[] | null }[], start, end);
      if (hit && saved.has(hit.version.engine)) r.peakPage = { id: hit.version.id, sig: signLogoUrl(`fzv:${hit.version.id}`), savedAt: hit.version.saved_at, sameAsNow: hit.sameAsNow };
    });
  }
  /* A saved baseline is never overwritten for the same change: new rows are inserted,
     existing ones only filled in where the date is empty or older than this change. */
  const fresh = firstSeen.filter((r) => !bySlug.has(r.slug));
  if (fresh.length) await svc.from("funnel_freeze").upsert(fresh, { onConflict: "slug", ignoreDuplicates: true });
  for (const { slug, ...values } of firstSeen.filter((r) => bySlug.has(r.slug))) {
    await svc.from("funnel_freeze").update(values).eq("slug", slug).or(`suggested_at.is.null,suggested_at.lt.${suggestions.get(slug)?.changeAt}`);
  }

  const others = rows
    .filter((r) => /v3/i.test(r.version) && r.clientStatus === "live" && !r.frozen)
    .reduce((a, r) => ({ l: a.l + r.now.l, d: a.d + r.now.d }), { l: 0, d: 0 });
  const board: Board = { engine: ONEBOX_ENGINE_V, suggestionsFailed, others, rows };
  return NextResponse.json(board);
}

const RECORD_WARNING = "Done, but its history entry wasn't saved.";

export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as { slug?: unknown; action?: unknown } | null;
  const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
  const action = body?.action;
  if (!slug || (action !== "freeze" && action !== "unfreeze" && action !== "decline" && action !== "undecline" && action !== "accept" && action !== "restore")) {
    return NextResponse.json({ error: "slug and action (freeze|unfreeze|decline|undecline|accept|restore) required" }, { status: 400 });
  }

  const svc = createServiceClient();
  const { data: client } = await svc.from("onebox_clients").select("*").eq("slug", slug).maybeSingle();
  if (!client) return NextResponse.json({ error: "Unknown funnel" }, { status: 404 });
  const { data: priorRow, error: priorError } = await svc.from("funnel_freeze").select("*").eq("slug", slug).maybeSingle();
  /* A failed read here would rewrite the history as empty. */
  if (priorError) return NextResponse.json({ error: "Couldn't read this funnel's record. Try again." }, { status: 503 });
  const prior = priorRow as FreezeRow | null;
  const history = prior?.history ?? [];
  const at = new Date().toISOString();
  const by = auth.email;

  if (action === "decline" || action === "undecline") {
    const declined = action === "decline";
    const { error } = await svc.from("funnel_freeze").upsert({
      slug,
      declined_at: declined ? at : null,
      declined_by: declined ? by : null,
      declined_note: null,
      history: [...history, { action, at, by }],
      updated_at: at,
    }, { onConflict: "slug" });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, declined: declined ? { at, note: null } : null });
  }

  if (action === "accept") {
    const row = client as OneboxRow;
    const changes = frozenDrift(row);
    if (!changes.length) return NextResponse.json({ ok: true, drift: [] });
    const next = acceptFrozenDrift(row);
    if (!next) return NextResponse.json({ error: "This funnel isn't frozen." }, { status: 409 });
    const { error } = await svc.from("onebox_clients").update({ frozen_page: next }).eq("slug", slug);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const { error: recordError } = await svc.from("funnel_freeze").upsert({ slug, history: [...history, { action, at, by, changes }], updated_at: at }, { onConflict: "slug" });
    warmFunnel(slug);
    await runFunnelTimeline(svc, { origin: req.nextUrl.origin, slug }).catch(() => {});
    return NextResponse.json({ ok: true, drift: [], warning: recordError ? RECORD_WARNING : undefined });
  }

  if (action === "unfreeze") {
    if (client.frozen_engine == null) {
      return NextResponse.json({ ok: true, frozen: null, restorable: prior?.last_frozen?.page ? { at: prior.last_frozen.at } : null });
    }
    /* One click undoes it, so the page it was keeping is saved first: if that
       fails, nothing changes. */
    const { error: recordError } = await svc.from("funnel_freeze").upsert({
      slug,
      frozen_by: null,
      frozen_leads: null,
      frozen_deposits: null,
      last_frozen: { engine: client.frozen_engine, at: client.frozen_at, by: prior?.frozen_by ?? null, leads: prior?.frozen_leads ?? null, deposits: prior?.frozen_deposits ?? null, page: client.frozen_page },
      history: [...history, { action, at, by, engine: client.frozen_engine }],
      updated_at: at,
    }, { onConflict: "slug" });
    if (recordError) return NextResponse.json({ error: "Couldn't save the frozen page, so nothing changed. Try again." }, { status: 500 });
    const { error } = await svc.from("onebox_clients").update({ frozen_engine: null, frozen_at: null, frozen_page: null }).eq("slug", slug);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    warmFunnel(slug);
    await runFunnelTimeline(svc, { origin: req.nextUrl.origin, slug }).catch(() => {});
    return NextResponse.json({ ok: true, frozen: null, restorable: client.frozen_page ? { at: client.frozen_at } : null });
  }

  // Freeze or restore.
  if (client.frozen_engine != null) {
    /* Frozen before snapshots existed: the page gets locked now. */
    if (!client.frozen_page) await svc.from("onebox_clients").update({ frozen_page: snapshotFunnelPage(client as OneboxRow) }).eq("slug", slug);
    return NextResponse.json({ ok: true, frozen: { engine: client.frozen_engine, at: client.frozen_at, by: prior?.frozen_by ?? null, l: prior?.frozen_leads ?? null, d: prior?.frozen_deposits ?? null }, drift: frozenDrift(client as OneboxRow) });
  }
  const blocked = await freezeBlockedReason(svc, client);
  if (blocked) return NextResponse.json({ error: blocked.error }, { status: blocked.status });
  if (action === "restore") {
    const last = prior?.last_frozen;
    if (!last?.page) return NextResponse.json({ error: "There's no saved page to restore." }, { status: 409 });
    const { error } = await svc.from("onebox_clients").update({ frozen_engine: last.engine, frozen_at: last.at, frozen_page: last.page }).eq("slug", slug);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const { error: recordError } = await svc.from("funnel_freeze").upsert({
      slug,
      frozen_by: last.by,
      frozen_leads: last.leads,
      frozen_deposits: last.deposits,
      last_frozen: null,
      history: [...history, { action, at, by, engine: last.engine }],
      updated_at: at,
    }, { onConflict: "slug" });
    warmFunnel(slug);
    await runFunnelTimeline(svc, { origin: req.nextUrl.origin, slug }).catch(() => {});
    return NextResponse.json({
      ok: true,
      frozen: { engine: last.engine, at: last.at, by: last.by, l: last.leads, d: last.deposits },
      drift: frozenDrift({ ...(client as OneboxRow), frozen_page: last.page }),
      restorable: null,
      warning: recordError ? RECORD_WARNING : undefined,
    });
  }

  const copyError = await ensureEngineCopy(svc, req.nextUrl.origin);
  if (copyError) return NextResponse.json({ error: copyError }, { status: 502 });

  /* The rate on the day, for "when frozen" vs "now". A stats failure never
     blocks the click: the screen shows a dash instead. */
  let leads: number | null = null;
  let deposits: number | null = null;
  try {
    const row = (await loadStats(svc)).find((s) => s.slug === slug);
    if (row) { leads = row.leads30; deposits = row.deposits30; }
  } catch { /* see above */ }

  /* One write: the engine and the page it shows freeze together. */
  const { error } = await svc.from("onebox_clients").update({ frozen_engine: ONEBOX_ENGINE_V, frozen_at: at, frozen_page: snapshotFunnelPage(client as OneboxRow) }).eq("slug", slug);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const { error: recordError } = await svc.from("funnel_freeze").upsert({
    slug,
    frozen_by: by,
    frozen_leads: leads,
    frozen_deposits: deposits,
    last_frozen: null,
    history: [...history, { action, at, by, engine: ONEBOX_ENGINE_V, leads, deposits }],
    updated_at: at,
  }, { onConflict: "slug" });
  warmFunnel(slug);
  await runFunnelTimeline(svc, { origin: req.nextUrl.origin, slug }).catch(() => {});
  return NextResponse.json({ ok: true, frozen: { engine: ONEBOX_ENGINE_V, at, by, l: leads, d: deposits }, drift: [], restorable: null, warning: recordError ? RECORD_WARNING : undefined });
}
