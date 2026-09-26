import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { refreshOneboxConfig, normalizeElfsight, harvestPixelId, ensureOneboxCustomValues, setOneboxCustomValues, setDepositFunnelUrl, healFunnelPhotos, photosAreOwn, classifyPhotos, getAreaFieldOptions, ONEBOX_EDITABLE_CVS, PERSON_DEDUPE_MS, personKeys } from "@/lib/onebox";
import { computeFunnelStats, countHitsBySlug, fetchAllRows, PAGE1_TEST_NAME, type StatsWindow } from "@/lib/onebox-insights";
import { findClientProgram, fetchProgramRows, type ProgramRow } from "@/lib/client-program";
import { listCheckoutTransactions } from "@/lib/fanbasis";

// Never serve cached fetches: Supabase rows and GHL availability must be live.
export const fetchCache = "force-no-store";

/* 300 not 120: the warm-after-save pings below run up to ~150s AFTER the
   response via waitUntil, and a slow resync (pixel self-heal probing dead
   pages) can eat ~60s before that — the timer must fit what remains. */
export const maxDuration = 300;

// Funnels tab (admin only): manage the one-box funnels.
//   GET                       → all funnels + lead/booking counts
//   POST {action:"add", slug, locationId, clientName, oldFunnelUrl?}
//   POST {action:"resync", slug}
//   POST {action:"extras", slug, fanbasisHtml?, elfsightId?, resultImgs?, metaPixelId?}
//   POST {action:"status", slug, status}         (live | paused)
//   POST {action:"health", slug}                 → live checks for one funnel
//   POST {action:"verifyRedirect", slug, adUrl}  → is the ad link redirecting onto this funnel? (Start Setup step 5)

type Extras = {
  faqs?: { q: string; a: string }[];
  fanbasisHtml?: string;
  elfsightId?: string;
  resultImgs?: string;
  metaPixelId?: string;
  oldFunnelUrl?: string;
  ownerName?: string;
  template?: string;
  /* Start Setup step 5: does the ad link (the GHL funnel URL already
     running in the ads) get a GHL URL Redirect onto this funnel? "yes" =
     redirect SOP + live verification gate Go live; "no" = ads use the
     one-box link directly. redirectVerifiedAt is set by verifyRedirect. */
  adRedirect?: "yes" | "no";
  redirectVerifiedAt?: string;
};

// Public funnel URL on the branded domain (book.pmu-care.com is a
// CNAME onto this same Vercel deployment; middleware rewrites the
// short path to /f/<slug> on that host).
const FUNNEL_ORIGIN = "https://book.pmu-care.com";

function funnelUrl(_req: NextRequest, slug: string): string {
  return `${FUNNEL_ORIGIN}/${slug}`;
}

export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Coaches read the list (their Funnels tab); every change below is still admin-only.
  if (auth.role !== "admin" && auth.role !== "editor" && auth.role !== "media_buyer") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const svc = createServiceClient();

  /* ?stats=7|14 → the always-on performance overview (post-A/B era):
     per live client, funnel-wide numbers for the window — no experiment
     needed. Spend comes from performance_overview (spent7/spent14),
     matched by the pinned Extras owner name, else the client name and
     its distinctive words — the same matching the split tables used. */
  const statsWin = req.nextUrl.searchParams.get("stats");
  if (statsWin === "7" || statsWin === "14" || statsWin === "30" || statsWin === "since") {
    /* The fleet traffic table is admin + media-buyer only (owner, 2026-09-26):
       coaches lost the "One-box performance — all clients" box on the Funnels
       tab, and hiding it in the UI alone would leave every client's visitors,
       leads and spend one hand-typed URL away. Gate the DATA, not the box. */
    if (auth.role !== "admin" && auth.role !== "media_buyer") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const days: StatsWindow = statsWin === "since" ? "since" : (Number(statsWin) as 7 | 14 | 30);
    const stats = await computeFunnelStats(svc, days);
    /* Which clients have a page-1 A/B test right now — the table shows
       its button next to the lead rate. */
    const { data: p1 } = await svc.from("onebox_experiments")
      .select("id, slug, status").eq("name", PAGE1_TEST_NAME).eq("status", "running");
    const page1: Record<string, number> = {};
    for (const e of p1 ?? []) page1[e.slug as string] = e.id as number;
    return NextResponse.json({ window: days, stats, page1 });
  }

  const { data: allRows } = await svc
    .from("onebox_clients")
    .select("slug, location_id, client_name, status, cv_synced_at, config, extras, created_at")
    .order("created_at", { ascending: true });
  /* Coaches and the media buyer see CLIENT (B2C) funnels only — the
     agency's own B2B funnels never leave the server for them (owner,
     2026-09-25; the page used to filter client-side). */
  const rows = auth.role === "admin"
    ? allRows
    : (allRows ?? []).filter((r) => ((r.extras ?? {}) as Extras).template !== "b2b");

  /* Leads are paged and visitors are COUNTED per slug — PostgREST caps
     any plain select at 1,000 rows, which silently froze these counters
     once the fleet outgrew that (see lib/onebox-insights). */
  const [leads, hitCounts, { data: expRows }, { data: programRows }] = await Promise.all([
    fetchAllRows((from, to) =>
      svc.from("onebox_leads").select("id, slug, ghl_status, picked_time_at, answers, created_at, phone, full_name")
        .order("id").range(from, to)),
    countHitsBySlug(svc, (rows ?? []).map((r) => r.slug as string)),
    svc.from("onebox_experiments").select("id, slug, status, created_at").order("created_at", { ascending: false }),
    svc.from("client_program_rows").select("sheet_row, business_name, version, owner_name"),
  ]);

  /* Which program (V3/V2.3/V1) is each funnel's client on? Same matcher
     and same Clients Master rows as the Clients tab and the funnel page
     itself — see lib/client-program. */
  const findProgram = (clientName: string) => findClientProgram((programRows ?? []) as ProgramRow[], clientName);
  /* One word per card: is a split test live right now? "running" beats
     any number of old paused/ended experiments for the same slug. */
  const abStatus: Record<string, string> = {};
  for (const e of expRows ?? []) {
    if (e.status === "running" || !abStatus[e.slug]) abStatus[e.slug] = e.status as string;
  }
  /* Where does traffic actually go? The splitter uses the NEWEST running
     experiment per slug; with none running it forwards every visitor to
     the one-box funnel. The card also needs the newest experiment that
     still has a real external (original-funnel) side, so "send traffic
     back to the original" is a resume, not a full re-setup — which is why
     variants are fetched for all experiments, not just running ones. */
  const newestRunning: Record<string, number> = {};
  const expsBySlug: Record<string, number[]> = {};
  for (const e of expRows ?? []) {
    if (e.status === "running" && newestRunning[e.slug] === undefined) newestRunning[e.slug] = e.id as number;
    (expsBySlug[e.slug] ??= []).push(e.id as number);
  }
  const trafficByExp: Record<number, { vkey: string; label: string; kind: string; weight: number; target: string | null }[]> = {};
  const expIds = (expRows ?? []).map((e) => e.id as number);
  if (expIds.length) {
    const { data: varRows } = await svc
      .from("onebox_variants")
      .select("experiment_id, vkey, label, kind, weight, target")
      .in("experiment_id", expIds)
      .order("vkey");
    for (const v of varRows ?? []) {
      (trafficByExp[v.experiment_id as number] ??= []).push({
        vkey: v.vkey as string, label: v.label as string, kind: v.kind as string, weight: (v.weight as number) ?? 0,
        target: (v.target as string | null) ?? null,
      });
    }
  }
  /* Reconcile against Fanbasis before counting: a deposit paid outside
     our checkout callback is almost always the AI's SMS follow-up
     converting a picked-no-deposit lead (the Michele/Norma pattern) —
     a different channel, so it must NOT count as a funnel deposit, but
     the team must see the lead as paid. Those leads get the distinct
     status "paid-followup": shown in the lead journey, excluded from
     the card's funnel-native deposit count. */
  const isPaid = (st: string | null) => st === "booked" || st === "paid" || st === "paid-not-booked" || st === "paid-followup";
  await Promise.all((rows ?? []).map(async (r) => {
    const pid = String(((r.config ?? {}) as Record<string, string>).fanbasisProductId ?? "").trim();
    if (!pid) return;
    const unpaid = (leads ?? []).filter((l) => l.slug === r.slug && !isPaid(l.ghl_status as string));
    if (!unpaid.length) return;
    try {
      const txns = await listCheckoutTransactions(pid);
      const paidIds: number[] = [];
      for (const l of unpaid) {
        const em = String(((l.answers ?? {}) as { email?: string }).email ?? "").trim().toLowerCase();
        if (!em) continue;
        const leadMs = new Date(l.created_at as string).getTime() - 3_600_000;
        const hit = txns.some((t) => {
          if (t.email !== em) return false;
          const raw = (t.raw ?? {}) as Record<string, unknown>;
          if (/test/i.test(String(((raw.fan ?? {}) as { name?: string }).name ?? ""))) return false;
          const ms = Date.parse(String(raw.transaction_date ?? raw.created_at ?? ""));
          return Number.isFinite(ms) && ms >= leadMs;
        });
        if (hit) { paidIds.push(l.id as number); l.ghl_status = "paid-followup"; }
      }
      if (paidIds.length) await svc.from("onebox_leads").update({ ghl_status: "paid-followup" }).in("id", paidIds);
    } catch { /* Fanbasis unreachable — count from stored statuses */ }
  }));

  // Funnel-stage counts: booked = picked a date+time (cumulative — every
  // payer picked too); paid = FUNNEL-NATIVE deposits only (statuses our
  // checkout callback sets). "paid-followup" (AI-recovered) counts as
  // picked but never as a funnel deposit.
  const counts: Record<string, { leads: number; booked: number; paid: number; lastLeadAt: string | null }> = {};
  /* Unique clients: same person re-submitting/re-paying within 21 days is
     ONE journey (see personKeys); they count again after 3+ weeks. */
  type CardJourney = { ms: number; booked: boolean; paid: boolean };
  const cardJourneys = new Map<string, CardJourney>();
  const sortedLeads = [...(leads ?? [])].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  for (const l of sortedLeads) {
    const c = (counts[l.slug] ??= { leads: 0, booked: 0, paid: 0, lastLeadAt: null });
    if (!c.lastLeadAt || l.created_at > c.lastLeadAt) c.lastLeadAt = l.created_at;
    const ms = new Date(l.created_at as string).getTime();
    const keys = personKeys(l.full_name as string, ((l.answers ?? {}) as { email?: string }).email, l.phone as string)
      .map((k) => `${l.slug}|${k}`);
    let j: CardJourney | undefined;
    for (const key of keys) {
      const hit = cardJourneys.get(key);
      if (hit && ms - hit.ms < PERSON_DEDUPE_MS) { j = hit; break; }
    }
    const depositPaid = l.ghl_status === "booked" || l.ghl_status === "paid" || l.ghl_status === "paid-not-booked";
    const booked = depositPaid || l.ghl_status === "paid-followup" || !!l.picked_time_at;
    if (!j) { j = { ms, booked: false, paid: false }; c.leads++; }
    if (depositPaid && !j.paid) { c.paid++; j.paid = true; }
    if (booked && !j.booked) { c.booked++; j.booked = true; }
    for (const key of keys) cardJourneys.set(key, j);
  }

  const out = (rows ?? []).map((r) => {
    const extras = (r.extras ?? {}) as Extras;
    const config = (r.config ?? {}) as Record<string, string>;
    return {
      slug: r.slug,
      locationId: r.location_id,
      clientName: r.client_name,
      status: r.status,
      cvSyncedAt: r.cv_synced_at,
      url: funnelUrl(req, r.slug),
      hasCalendar: !!config.calendarId,
      hasFanbasis: !!(config.fanbasisProductId || config.fanbasisCode || extras.fanbasisHtml),
      hasWidget: !!(config.igWidget || config.googleWidget || config.elfsightId || extras.elfsightId || config.resultImgs || extras.resultImgs),
      hasPixel: !!((config.metaPixelId || extras.metaPixelId || "").replace(/\D/g, "")),
      pixelId: (config.metaPixelId || extras.metaPixelId || "").replace(/\D/g, ""),
      oldFunnelUrl: extras.oldFunnelUrl ?? "",
      adRedirect: extras.adRedirect ?? "",
      redirectVerifiedAt: extras.redirectVerifiedAt ?? null,
      template: extras.template ?? "",
      cv: Object.fromEntries(Object.keys(ONEBOX_EDITABLE_CVS).map((k) => [k, config[k] ?? ""])),
      visitors: hitCounts[r.slug] ?? 0,
      leads: counts[r.slug]?.leads ?? 0,
      booked: counts[r.slug]?.booked ?? 0,
      paid: counts[r.slug]?.paid ?? 0,
      lastLeadAt: counts[r.slug]?.lastLeadAt ?? null,
      abStatus: abStatus[r.slug] ?? null,
      program: r.slug === "demo-v3" || (extras.template ?? "") === "b2b" ? null : findProgram(String(r.client_name ?? "")),
      traffic: (() => {
        const runId = newestRunning[r.slug];
        if (runId !== undefined) return { expId: runId, status: "running", variants: trafficByExp[runId] ?? [] };
        /* Nothing running: the newest paused test with an external side is
           the one-click path back to the original funnel. Newest-first. */
        const resumable = (expsBySlug[r.slug] ?? []).find((eid) =>
          (trafficByExp[eid] ?? []).some((v) => v.kind === "external" && v.target)
        );
        return resumable !== undefined
          ? { expId: resumable, status: "paused", variants: trafficByExp[resumable] ?? [] }
          : null;
      })(),
    };
  });
  return NextResponse.json({ funnels: out });
}

export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  /* Client Success Coaches (role "editor") onboard clients: they may add
     a funnel and save Start Setup (custom values + extras). Everything
     that moves traffic or money stays admin-only. */
  // "status" = the Go live / Pause button: coaches publish their own
  // onboardings without waiting on an admin (Netzah, 2026-09-16).
  /* Under the funnel page's long stale-while-revalidate window, a quiet
   funnel could keep serving pre-edit copy for as long as nobody visits.
   After any dashboard-driven config change we act as the funnel's next
   visitor once the 60s fresh window has lapsed, so the edge revalidates
   with the new copy within ~2 minutes. The "ob-warm" UA is in the funnel
   route's scraper list: on A/B-test clients (always no-store) the ping is
   a harmless no-op that mints no assignment row. */
/* First survey question from the account's own data: the options of the
   "CC - Which Area(s) Would You Like Treated?" contact field are what the
   client's GHL survey maps onto, so the one-box asks exactly those — one
   service or five. Runs only while no survey exists yet (never over an
   edited one). Even ONE option is seeded: the dashboard's fallback
   template says "Lips; Eyebrows", which is wrong for a brows-only studio. */
async function seedSurveyFromAccount(
  svc: ReturnType<typeof createServiceClient>, slug: string, locationId: string, config: Record<string, string> | null,
): Promise<{ config: Record<string, string> | null; note: string; seeded: boolean }> {
  if ((config?.surveyRaw ?? "").trim()) return { config, note: "", seeded: false };
  const areas = await getAreaFieldOptions(locationId);
  if (!areas.length) return { config, note: "standard survey (no service list on the CC - Which Area(s) field)", seeded: false };
  const surveyRaw = [
    `Which Area(s) Would You Like Treated? | ${areas.join("; ")}`,
    "Have You Ever Had Permanent Makeup Before? | Yes; No",
    "What Age Group Are You In? | 18-24; 24-30; 30-36; 36-42; 42-54; 54-65; 65+",
    "Our Address is {address}. Is This commutable for you? | Yes; No",
    "On A Scale From 1-10 How Serious Are You About Getting This Treatment? | 0-2; 3-6; 7-9; 10 I Want This Treatment!",
    "Would you like a FREE Aftercare Kit? | Yes; No",
  ].join("\n");
  const res = await setOneboxCustomValues(locationId, [{ name: "OB - Survey Questions", value: surveyRaw }]);
  if (res.error) return { config, note: `survey not seeded (${res.error})`, seeded: false };
  const fresh = await refreshOneboxConfig(svc, slug, locationId, { "OB - Survey Questions": surveyRaw });
  return { config: fresh, note: `survey seeded with the account's services: ${areas.join(", ")}`, seeded: true };
}

function warmFunnel(slug: string) {
  waitUntil((async () => {
    /* Two pings: an in-flight pre-save render can be stored by the CDN
       seconds after the save, making a single +65s ping land inside that
       entry's fresh minute and revalidate nothing. The second ping at
       +150s is past any such window. */
    for (const delayMs of [75_000, 150_000]) {
      await new Promise((r) => setTimeout(r, delayMs === 75_000 ? delayMs : delayMs - 75_000));
      await fetch(`https://book.pmu-care.com/${slug}`, {
        cache: "no-store",
        headers: { "user-agent": "ob-warm/1 (cache refresh after dashboard save)" },
      }).catch(() => {});
    }
  })());
}

const COACH_ACTIONS = new Set(["add", "cvs", "extras", "status", "health", "verifyRedirect"]);
  /* The media buyer updates funnel OFFERS (owner, 2026-09-25): only the
     "cvs" action, and the cvs handler below restricts them to the offer
     field. Everything else stays admin/coach territory. */
  const MEDIA_BUYER_ACTIONS = new Set(["cvs"]);
  if (
    auth.role !== "admin" &&
    !(auth.role === "editor" && COACH_ACTIONS.has(String(body.action ?? ""))) &&
    !(auth.role === "media_buyer" && MEDIA_BUYER_ACTIONS.has(String(body.action ?? "")))
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const svc = createServiceClient();
  const action = String(body.action ?? "");
  const slug = String(body.slug ?? "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

  if (action === "add") {
    const locationId = String(body.locationId ?? "").trim();
    if (!slug || !locationId) return NextResponse.json({ error: "slug and locationId required" }, { status: 400 });
    const { data: existing } = await svc.from("onebox_clients").select("slug, client_name, location_id").eq("slug", slug).maybeSingle();
    if (existing) {
      const sameAccount = String(existing.location_id) === locationId;
      return NextResponse.json({
        error: sameAccount
          ? `this sub-account already has a funnel: "${existing.client_name}" (slug ${slug}) — search for it above`
          : `slug "${slug}" is already used by "${existing.client_name}" (a different sub-account) — pick another slug, or search for "${existing.client_name}" if that funnel is misnamed`,
      }, { status: 409 });
    }

    /* Meta pixel: GHL injects it on the BOOKING page, not always on the
       survey page — so harvest tries the given URL, then the derived
       booking page, then a slug-guessed booking page when no URL given. */
    const extras: Extras = {};
    let pixelNote = "";
    const oldUrl = String(body.oldFunnelUrl ?? "").trim();
    if (oldUrl) extras.oldFunnelUrl = oldUrl;
    const pixelCandidates = [
      ...(oldUrl ? [oldUrl, oldUrl.replace(/-survey[a-z0-9-]*\/?$/i, "-booking")] : []),
      `https://pmu-care.com/${slug}-booking`,
    ];
    for (const u of [...new Set(pixelCandidates)]) {
      const pixel = await harvestPixelId(u);
      if (pixel) { extras.metaPixelId = pixel; pixelNote = `pixel ${pixel} harvested from ${u}`; break; }
    }
    if (!extras.metaPixelId) pixelNote = "no pixel found on the funnel pages — set OB - Meta Pixel ID or Extras";

    await svc.from("onebox_clients").insert({
      slug,
      location_id: locationId,
      client_name: String(body.clientName ?? "").trim(),
      status: "paused",
      extras,
    });
    // Older sub-accounts miss the one-box custom values — create the
    // absent ones (empty) so the team only has to fill values in GHL.
    const ensured = await ensureOneboxCustomValues(locationId);
    let config = await refreshOneboxConfig(svc, slug, locationId);
    /* Photos come along automatically: whenever the photo CVs are empty
       OR still the snapshot's stock pictures, harvest the client's own
       before/after and studio photos from the original booking page. */
    const bookingUrl = oldUrl
      ? oldUrl.replace(/-survey[a-z0-9-]*\/?$/i, "-booking")
      : `https://pmu-care.com/${slug}-booking`;
    const healed = await healFunnelPhotos(svc, slug, locationId, bookingUrl, config);
    config = healed.config;
    const photoNote = healed.note;
    /* First survey question from the account's own data: the options on
       the "CC - Which Area(s)…" contact field ARE the client's service
       list (Netzah, 2026-09-19). Seed OB - Survey Questions with them so
       a new funnel offers the right services from day one — only when no
       survey exists yet, never over an edited one. */
    const seeded = await seedSurveyFromAccount(svc, slug, locationId, config);
    config = seeded.config;
    const surveyNote = seeded.note;
    return NextResponse.json({
      ok: true, slug, url: funnelUrl(req, slug), pixelNote, photoNote, surveyNote,
      cvNote: ensured.created.length
        ? `created ${ensured.created.length} missing custom values: ${ensured.created.join(", ")} — fill them in GHL`
        : "all one-box custom values already existed",
      synced: !!config, calendarId: config?.calendarId ?? "",
    });
  }

  if (!slug) return NextResponse.json({ error: "slug required" }, { status: 400 });
  const { data: row } = await svc.from("onebox_clients").select("*").eq("slug", slug).single();
  if (!row) return NextResponse.json({ error: "unknown slug" }, { status: 404 });
  /* Coaches and the media buyer work on CLIENT (B2C) funnels only — the
     agency's own B2B funnels are admin territory (owner, 2026-09-25). */
  if (auth.role !== "admin" && ((row.extras ?? {}) as Extras).template === "b2b") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (action === "resync") {
    const config = await refreshOneboxConfig(svc, slug, row.location_id as string);
    /* Pixel self-heal: harvesting only ran at Add-client, so clients
       added before that automation (or whose harvest failed that day)
       stayed pixel-less forever. Sync now retries it whenever the
       pixel is still missing — same candidates as Add-client. */
    const ex = (row.extras ?? {}) as { metaPixelId?: string; oldFunnelUrl?: string };
    const havePixel = ((config?.metaPixelId || ex.metaPixelId || "").replace(/\D/g, "")).length > 0;
    let pixelNote: string | undefined;
    if (!havePixel) {
      const candidates = new Set<string>();
      const oldUrl = (ex.oldFunnelUrl ?? "").trim();
      if (oldUrl) {
        /* After the cutover the ad link 301s to us and carries no pixel —
           the renamed -old page is where the original (and its pixel)
           still lives; check it first. */
        candidates.add(oldUrl.replace(/\/?$/, "") + "-old");
        candidates.add(oldUrl);
        candidates.add(oldUrl.replace(/-survey(?:-ab-ghl)?\/?$/, "-booking"));
      }
      candidates.add(`https://pmu-care.com/${slug}-booking`);
      candidates.add(`https://pmu-care.com/${slug}-survey`);
      for (const url of candidates) {
        const id = await harvestPixelId(url);
        if (id) {
          await svc
            .from("onebox_clients")
            .update({ extras: { ...(row.extras ?? {}), metaPixelId: id } })
            .eq("slug", slug);
          pixelNote = `pixel found (${id})`;
          break;
        }
      }
      if (!pixelNote) pixelNote = "pixel still not found on the original pages";
    }
    /* Photo self-heal, same idea: stock snapshot pictures in the photo
       CVs are replaced with the client's own from the original funnel. */
    const oldUrlForPhotos = (ex.oldFunnelUrl ?? "").trim();
    const bookingUrl = oldUrlForPhotos
      ? oldUrlForPhotos.replace(/-survey[a-z0-9-]*\/?$/i, "-booking")
      : `https://pmu-care.com/${slug}-booking`;
    const healed = await healFunnelPhotos(svc, slug, row.location_id as string, bookingUrl, config);
    /* Survey self-heal: a funnel still on the default question set gets
       the account's own services (the seed used to skip single-service
       accounts, so those showed "Lips; Eyebrows" — The Wellness Place). */
    const seeded = await seedSurveyFromAccount(svc, slug, row.location_id as string, healed.config);
    warmFunnel(slug);
    return NextResponse.json({ ok: !!seeded.config, config: seeded.config, pixelNote, photoNote: healed.note || undefined, surveyNote: seeded.seeded ? seeded.note : undefined });
  }

  if (action === "status") {
    const status = body.status === "live" ? "live" : "paused";
    await svc.from("onebox_clients").update({ status, updated_at: new Date().toISOString() }).eq("slug", slug);
    /* Going LIVE on a B2C one-box also points the sub-account's
       deposit-funnel-URL custom value at this client's own funnel
       (book.pmu-care.com/<slug>) — the AI's pay link and the template
       workflows read it, and a stale value sends paid traffic to the old
       GHL funnel (owner rule, 2026-09-23). Never blocks the status flip. */
    let depositUrlNote: string | undefined;
    const isB2BStatus = ((row.extras ?? {}) as Extras).template === "b2b";
    if (status === "live" && !isB2BStatus) {
      const url = funnelUrl(req, slug);
      const res = await setDepositFunnelUrl(row.location_id as string, url);
      if (res.ok) {
        depositUrlNote = `Deposit funnel URL → ${url}`;
        const cfg = { ...((row.config ?? {}) as Record<string, string>), depositFunnelUrl: url };
        await svc.from("onebox_clients").update({ config: cfg }).eq("slug", slug);
        warmFunnel(slug);
      } else {
        depositUrlNote = `⚠ Deposit funnel URL not updated (${res.error ?? "GHL error"}) — set it in Start Setup`;
      }
    }
    return NextResponse.json({ ok: true, status, depositUrlNote });
  }

  if (action === "extras") {
    const extras = { ...(row.extras as Extras) };
    if (body.fanbasisHtml !== undefined) extras.fanbasisHtml = String(body.fanbasisHtml);
    if (body.elfsightId !== undefined) extras.elfsightId = normalizeElfsight(body.elfsightId);
    if (body.resultImgs !== undefined) extras.resultImgs = String(body.resultImgs);
    if (body.metaPixelId !== undefined) extras.metaPixelId = String(body.metaPixelId).replace(/\D/g, "");
    if (body.oldFunnelUrl !== undefined) extras.oldFunnelUrl = String(body.oldFunnelUrl).trim();
    if (body.ownerName !== undefined) extras.ownerName = String(body.ownerName).trim();
    if (body.adRedirect !== undefined) {
      const v = String(body.adRedirect);
      if (v === "yes" || v === "no") extras.adRedirect = v; else delete extras.adRedirect;
    }
    await svc.from("onebox_clients").update({ extras, updated_at: new Date().toISOString() }).eq("slug", slug);
    warmFunnel(slug);
    return NextResponse.json({ ok: true, elfsightId: extras.elfsightId ?? "" });
  }

  if (action === "cvs") {
    // Write the submitted values straight into the sub-account's custom
    // values, then resync so the funnel reflects them immediately.
    let values: Record<string, unknown> = {};
    try { values = JSON.parse(String(body.values ?? "{}")); } catch { /* empty */ }
    // The media buyer may change the offer and nothing else.
    if (auth.role === "media_buyer") {
      values = "offer" in values ? { offer: values.offer } : {};
      if (!Object.keys(values).length) return NextResponse.json({ error: "media buyers can only update the offer" }, { status: 403 });
    }
    const entries: { name: string; value: string }[] = [];
    for (const [key, cvName] of Object.entries(ONEBOX_EDITABLE_CVS)) {
      if (key in values && typeof values[key] === "string") {
        entries.push({ name: cvName, value: (values[key] as string).trim().slice(0, 2000) });
      }
    }
    if (!entries.length) return NextResponse.json({ error: "no values" }, { status: 400 });
    const res = await setOneboxCustomValues(row.location_id as string, entries);
    if (res.error) return NextResponse.json({ error: `GHL write failed (${res.error})` }, { status: 502 });
    /* Write-through instead of read-after-write: GHL's custom-values list
       can lag a just-made write, so an immediate resync sometimes came
       back with the OLD values and clobbered the stored config — the
       Values panel then reopened empty even though GHL saved fine
       (Netzah hit this repeatedly with the IG-widget link). What GHL
       just accepted IS the truth; merge it in ourselves and let the
       regular 5-minute resync reconcile once their list catches up. */
    const writtenNames = new Set(res.written);
    /* Re-read with the just-written values merged over GHL's (lagging)
       list, so aggregated fields (resultCvImgs / studioCvImgs from the
       photo slots) are rebuilt in the same request. */
    const justWritten = Object.fromEntries(entries.filter((e) => writtenNames.has(e.name)).map((e) => [e.name, e.value]));
    const cfg = (await refreshOneboxConfig(svc, slug, row.location_id as string, justWritten)) ?? { ...((row.config ?? {}) as Record<string, string>), ...Object.fromEntries(Object.entries(ONEBOX_EDITABLE_CVS).filter(([, n]) => n in justWritten).map(([k, n]) => [k, justWritten[n]])) };
    const failed = entries.filter((e) => !writtenNames.has(e.name)).map((e) => e.name);
    warmFunnel(slug);
    return NextResponse.json({ ok: true, written: res.written.length, failed, config: cfg });
  }

  /* Start Setup step 5 — live check that the ad link now lands on this
     funnel. Only the ad URL's redirect header is inspected (redirect:
     manual), so a still-draft funnel doesn't fail it: the point is to
     confirm the GHL redirect BEFORE Go live, exactly in the SOP order.
     The renamed original (…-old) is checked too, as information only —
     it is the rollback, not a requirement. On success the ad URL and the
     verification time are stored on the funnel so the card shows it. */
  if (action === "verifyRedirect") {
    const adUrlRaw = String(body.adUrl ?? "").trim();
    let au: URL;
    try { au = new URL(adUrlRaw); } catch { return NextResponse.json({ error: "the ad link is not a valid URL" }, { status: 400 }); }
    au.search = ""; au.hash = "";
    au.pathname = au.pathname.replace(/\/+$/, "");
    /* The redirect target is the splitter (/s/<slug>): with no test running
       it is simply the funnel, and a later split test needs no redirect
       change. The plain and /f/ paths are accepted too. */
    const target = `${FUNNEL_ORIGIN}/s/${slug}`;
    const okPaths = new Set([`/${slug}`, `/s/${slug}`, `/f/${slug}`]);
    const landsHere = (loc: string): boolean => {
      try {
        const lu = new URL(loc, au.toString());
        const path = lu.pathname.replace(/\/+$/, "");
        return lu.hostname === new URL(target).hostname && okPaths.has(path);
      } catch { return false; }
    };
    let redirectLive = false, redirectNote = "", landsOn = "";
    try {
      const r = await fetch(au.toString(), { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(12000) });
      const loc = r.headers.get("location") ?? "";
      landsOn = loc;
      if (r.status >= 300 && r.status < 400 && landsHere(loc)) redirectLive = true;
      else if (r.status >= 300 && r.status < 400) redirectNote = `the ad link redirects to ${loc.slice(0, 120)} — expected ${target}`;
      else if (r.status === 404) redirectNote = "the ad link is a dead 404 right now — ad clicks are being wasted; create the URL Redirect";
      else redirectNote = "no redirect yet — the ad link still opens the GHL page directly";
    } catch { redirectNote = "could not reach the ad link — try again"; }

    const ou = new URL(au.toString());
    ou.pathname = ou.pathname + "-old";
    let originalKept = false, originalNote = "";
    try {
      const r = await fetch(ou.toString(), { redirect: "follow", cache: "no-store", signal: AbortSignal.timeout(12000) });
      if (r.ok && !/book\.pmu-care\.com|\/s\/|\/f\//.test(r.url)) { originalKept = true; originalNote = `original page kept at ${ou.pathname} (rollback ready)`; }
      else if (r.ok) originalNote = `${ou.pathname} also redirects here — the original page was not renamed, fine but no rollback copy`;
      else originalNote = `no page at ${ou.pathname} — the original page was not renamed to -old (optional: keeps a rollback copy)`;
    } catch { originalNote = "could not check the -old page"; }

    if (redirectLive) {
      const extras = { ...(row.extras as Extras) };
      extras.oldFunnelUrl = au.toString();
      extras.adRedirect = "yes";
      extras.redirectVerifiedAt = new Date().toISOString();
      await svc.from("onebox_clients").update({ extras, updated_at: new Date().toISOString() }).eq("slug", slug);
    }
    return NextResponse.json({
      ok: redirectLive, adUrl: au.toString(), target, landsOn,
      checks: { redirectLive, redirectNote, originalKept, originalNote },
    });
  }

  if (action === "health") {
    const config = (row.config ?? {}) as Record<string, string>;
    const extras = (row.extras ?? {}) as Extras;
    const checks: { name: string; ok: boolean; note: string }[] = [];
    /* V1 has no deposit checkout, so no Commas product is expected — and
       the owner keeps V1 setups photo-light too, so the client-photos
       check only applies from V2.3 up (owner, 2026-09-25). Same version
       source as the card's program chip. */
    const program = findClientProgram(await fetchProgramRows(svc), String(row.client_name ?? ""));
    const isV1Client = /v1/i.test(program?.version ?? "");

    // page serves
    let pageOk = false;
    try {
      const r = await fetch(funnelUrl(req, slug), { signal: AbortSignal.timeout(15000) });
      pageOk = r.ok && (await r.text()).includes("onebox-root");
    } catch { /* stays false */ }
    checks.push({ name: "Funnel page loads", ok: pageOk, note: pageOk ? "200 OK" : row.status === "draft" ? "status is draft" : "page failed to load" });

    // availability
    let slotsOk = false, slotNote = "";
    if (config.calendarId) {
      try {
        const start = Date.now(), end = start + 21 * 86400000;
        const r = await fetch(`${req.nextUrl.origin}/api/onebox/slots?slug=${slug}&start=${start}&end=${end}`, { signal: AbortSignal.timeout(20000) });
        const j = (await r.json()) as { ok?: boolean; dates?: Record<string, string[]> };
        const days = Object.keys(j.dates ?? {}).length;
        slotsOk = !!j.ok && days > 0;
        slotNote = slotsOk ? `${days} days with open times` : "no available slots returned";
      } catch { slotNote = "availability check failed"; }
    } else slotNote = "no calendar id in custom values";
    checks.push({ name: "Calendar availability", ok: slotsOk, note: slotNote });

    const fbPid = (config.fanbasisProductId || "").trim();
    const fbCode = (config.fanbasisCode || "").trim() || extras.fanbasisHtml || "";
    if (!isV1Client) checks.push({
      name: "Commas checkout",
      ok: !!(fbPid || fbCode),
      note: fbPid ? `product ${fbPid} (custom value)` : fbCode ? `${fbCode.length} chars` : "add 'CC - Fanbasis Product ID' custom value",
    });
    const pixel = (config.metaPixelId || extras.metaPixelId || "").replace(/\D/g, "");
    checks.push({ name: "Meta pixel", ok: !!pixel, note: pixel ? `pixel ${pixel}` : "no pixel — harvest or set OB - Meta Pixel ID" });
    /* Stock snapshot photos look "filled" but are not the client's — the
       page would show strangers' brows and someone else's studio. */
    const [baKinds, stKinds] = await Promise.all([
      classifyPhotos(config.resultCvImgs || config.resultImgs || extras.resultImgs),
      classifyPhotos(config.studioCvImgs || config.studioImgs),
    ]);
    const describe = (label: string, kinds: { kind: string }[]) => {
      if (!kinds.length) return `${label}: none`;
      const stock = kinds.filter((k) => k.kind === "stock").length, broken = kinds.filter((k) => k.kind === "broken").length;
      if (!stock && !broken) return `${label}: ${kinds.length} own`;
      return `${label}: ${stock ? `${stock} of ${kinds.length} are the template's stock pictures` : ""}${stock && broken ? ", " : ""}${broken ? `${broken} broken` : ""}`;
    };
    const ownBa = photosAreOwn(baKinds), ownStudio = photosAreOwn(stKinds);
    if (!isV1Client) checks.push({
      name: "Client photos",
      ok: ownBa && ownStudio,
      note: `${describe("before/after", baKinds)} · ${describe("studio", stKinds)}${ownBa && ownStudio ? "" : " — upload the client's own into the photo custom values in GHL (Sync pulls them from the original page when it has them)"}`,
    });
    // Which required values are still empty on the account.
    const requiredCfg: [string, string][] = [
      ["biz", "Business Name"], ["phone", "CC - Business Phone Number"],
      ["address", "CC - Full Business Address"], ["offer", "CC - Offer"],
      ["calendarId", "CC - Permanent Makeup Transformation Calendar ID🔵"],
      ...(isV1Client ? [] : [["fanbasisProductId", "CC - Fanbasis Product ID"] as [string, string]]),
    ];
    const missingCvs = requiredCfg.filter(([k]) => !(config[k] ?? "").trim()).map(([, n]) => n);
    checks.push({
      name: "Custom values",
      ok: missingCvs.length === 0,
      note: missingCvs.length ? `empty or missing: ${missingCvs.join(", ")}` : "all required values filled",
    });
    const syncAge = row.cv_synced_at ? Date.now() - new Date(row.cv_synced_at as string).getTime() : Infinity;
    checks.push({ name: "GHL content sync", ok: syncAge < 30 * 60000, note: row.cv_synced_at ? `synced ${Math.round(syncAge / 60000)}m ago` : "never synced" });

    return NextResponse.json({ ok: checks.every((c) => c.ok), checks });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
