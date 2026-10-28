import { createServiceClient } from "@/lib/supabase/server";
import { arrangeFeed, type IgFeed, type IgPicks } from "@/lib/ig-arrange";
import { usernameFromLink } from "@/lib/ig-fetch";

/* Funnel widget health (owner, 10/28/2026: "I'm afraid the change we did with
   the Instagram widget and Google reviews won't work properly").

   Every few hours, for every live B2C funnel:
   1. Open the page the way a visitor gets it (book.pmu-care.com/f/<slug>,
      through the CDN) and read the config it ships: does it carry the
      Instagram grid and the Google reviews we have stored for this client?
   2. Load every grid picture + the profile photo the page points at: each
      must answer 200 with an image.
   3. Read what REAL visitors' browsers reported in the last 24 h
      (onebox_render_reports, sent by the engine): grid tiles and review cards
      actually drawn, pictures that failed, errors while drawing.
   4. Check the two refresh jobs are still running (both refresh every 13
      days; > 20 days old = the job stopped for this client).

   Anything broken → one "funnel_widgets" alert per client on the Alerts tab
   (updated as the problem changes, closed automatically once it's fine).
   Things only the client can fix (private Instagram, too few posts, no
   Google listing, no written 4–5★ reviews) are NOT alerts — they're listed
   as "not showing, and why" on the Funnels-tab card. */

type Svc = ReturnType<typeof createServiceClient>;
const BASE = process.env.FUNNEL_BASE_URL || "https://book.pmu-care.com";
const STALE_DAYS = 20;
const CONCURRENCY = 6;

export type Issue = { code: string; severity: "high" | "medium"; text: string; fix: string };
export type GapReason = { slug: string; name: string; what: "instagram" | "reviews"; why: string };
type Row = { slug: string; client_name: string | null; config: Record<string, string> | null; extras: Record<string, unknown> | null };
type Report = { slug: string; visitor_id: string; kind: string; grid_expected: boolean | null; grid_tiles: number | null; rev_expected: boolean | null; rev_cards: number | null; url: string | null; error: string | null };

/** Pull window.OB_CONFIG={...} out of the served page (balanced-brace scan, string-aware). */
export function servedConfig(html: string): Record<string, string> | null {
  const at = html.indexOf("window.OB_CONFIG=");
  if (at < 0) return null;
  const start = html.indexOf("{", at);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)) as Record<string, string>; } catch { return null; }
      }
    }
  }
  return null;
}

async function timedFetch(url: string, init: RequestInit = {}, ms = 15_000): Promise<Response | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal, cache: "no-store", redirect: "follow" });
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** true = the picture loads (200 + image/*). One retry for a flaky network. */
async function imageOk(url: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await timedFetch(url, { method: "GET", headers: { Range: "bytes=0-1023" } }, 10_000);
    if (r && (r.status === 200 || r.status === 206) && /^image\//i.test(r.headers.get("content-type") ?? "")) {
      try { await r.body?.cancel(); } catch { /* ignore */ }
      return true;
    }
    try { await r?.body?.cancel(); } catch { /* ignore */ }
  }
  return false;
}

const daysSince = (iso: string | null | undefined) => (iso ? (Date.now() - Date.parse(iso)) / 86400_000 : Infinity);

function igGap(row: Row): string | null {
  const ex = (row.extras ?? {}) as { igWidgetOff?: boolean; igFetch?: { ok?: boolean; why?: string } };
  const link = String(row.config?.igLink ?? "").trim();
  if (ex.igWidgetOff) return "switched off by us (off-topic feed)";
  if (!link) return "no Instagram link from the client";
  if (!usernameFromLink(link)) return "the Instagram link isn't an Instagram profile";
  const why = String(ex.igFetch?.why ?? "");
  if (/restricted|private|no posts returned/i.test(why)) return "profile is private or restricted — ask the client to make it public";
  if (/only \d+ posts? returned/i.test(why)) return "too few posts on the profile (needs 3+)";
  if (ex.igFetch?.ok === false) return `Instagram fetch failed: ${why || "unknown"}`;
  return "not fetched yet";
}

function reviewsGap(row: Row): string | null {
  const ex = (row.extras ?? {}) as { gWidgetOff?: boolean; gFetch?: { ok?: boolean; why?: string } };
  if (ex.gWidgetOff) return "switched off by us";
  const why = String(ex.gFetch?.why ?? "");
  if (/no 4\+ star reviews/i.test(why)) return "no written 4–5★ reviews on Google yet";
  if (/place not found/i.test(why)) return "no Google listing found — ask the client for their Google Business link";
  if (ex.gFetch?.ok === false) return `Google fetch failed: ${why || "unknown"}`;
  if (!ex.gFetch) return "not fetched yet";
  return "no reviews to show";
}

export async function runFunnelHealth(svc: Svc, opts: { dry?: boolean; slug?: string; deadlineMs?: number } = {}) {
  const started = Date.now();
  const deadline = opts.deadlineMs ?? 260_000;
  let q = svc.from("onebox_clients").select("slug, client_name, config, extras").eq("status", "live");
  if (opts.slug) q = q.eq("slug", opts.slug);
  const { data: rows, error } = await q;
  if (error) throw new Error(error.message);
  const clients = ((rows ?? []) as Row[]).filter((r) => (r.extras as { template?: string } | null)?.template !== "b2b");

  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const reports: Report[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await svc.from("onebox_render_reports").select("slug, visitor_id, kind, grid_expected, grid_tiles, rev_expected, rev_cards, url, error").gte("created_at", since).range(from, from + 999);
    reports.push(...((data ?? []) as Report[]));
    if (!data || data.length < 1000) break;
  }
  const repBySlug = new Map<string, Report[]>();
  for (const r of reports) repBySlug.set(r.slug, [...(repBySlug.get(r.slug) ?? []), r]);

  type Result = { slug: string; name: string; checked: boolean; gridOk: boolean; reviewsOk: boolean; issues: Issue[]; gaps: GapReason[]; visits: number };
  const results: Result[] = [];
  const queue = [...clients];
  const worker = async () => {
    for (;;) {
      const c = queue.shift();
      if (!c) return;
      const name = c.client_name || c.slug;
      if (Date.now() - started > deadline) { results.push({ slug: c.slug, name, checked: false, gridOk: false, reviewsOk: false, issues: [], gaps: [], visits: 0 }); continue; }
      const ex = (c.extras ?? {}) as { igWidgetOff?: boolean; igFeed?: IgFeed; igPicks?: IgPicks; igFrozen?: boolean; igSnapshot?: { imgs?: string[] }; gWidgetOff?: boolean; gReviews?: { reviews?: unknown[] }; gFetch?: { at?: string }; igFetch?: { at?: string } };
      const storedGrid = ex.igWidgetOff ? 0 : ex.igFrozen && ex.igSnapshot?.imgs?.length ? ex.igSnapshot.imgs.length : ex.igFeed?.imgs?.length ? arrangeFeed(ex.igFeed, ex.igPicks).imgs.length : 0;
      const igExpected = storedGrid >= 3;
      const revExpected = !ex.gWidgetOff && (ex.gReviews?.reviews?.length ?? 0) > 0;
      const issues: Issue[] = [];
      const gaps: GapReason[] = [];
      if (!igExpected) { const g = igGap(c); if (g) gaps.push({ slug: c.slug, name, what: "instagram", why: g }); }
      if (!revExpected) { const g = reviewsGap(c); if (g) gaps.push({ slug: c.slug, name, what: "reviews", why: g }); }

      // 1. The page as visitors get it.
      const page = await timedFetch(`${BASE}/f/${c.slug}`, { headers: { "User-Agent": "PMU-funnel-health/1.0" } });
      const html = page && page.ok ? await page.text().catch(() => "") : "";
      const cfg = html ? servedConfig(html) : null;
      let servedImgs: string[] = [];
      let servedPic = "";
      let servedReviews = 0;
      if (!page || !page.ok || !cfg || !/\/onebox\.js\?v=/.test(html)) {
        issues.push({ code: "page_down", severity: "high", text: `The funnel page didn't load properly (${page ? `HTTP ${page.status}` : "no response"}${page?.ok && !cfg ? ", no page config" : ""}).`, fix: "Open the funnel link yourself; if it's down, tell Netzah/dev right away — every lead is lost while it's down." });
      } else {
        try {
          const f = cfg.igFeed ? (JSON.parse(cfg.igFeed) as { imgs?: string[]; profile?: { pic?: string } }) : null;
          servedImgs = String(cfg.igFrozenImgs ?? "").split(",").map((u) => u.trim()).filter(Boolean);
          if (!servedImgs.length) servedImgs = f?.imgs ?? [];
          servedPic = f?.profile?.pic ?? "";
        } catch { servedImgs = []; }
        try { servedReviews = cfg.gReviews ? ((JSON.parse(cfg.gReviews) as { reviews?: unknown[] }).reviews?.length ?? 0) : 0; } catch { servedReviews = 0; }
        if (igExpected && servedImgs.length < 3) issues.push({ code: "ig_missing_on_page", severity: "high", text: `We have ${storedGrid} Instagram pictures for this client but the live page shows ${servedImgs.length}.`, fix: "Open the CPD → client → Instagram grid panel and press Refresh from Instagram now; if it still doesn't show, it's a code problem — tell dev." });
        if (revExpected && servedReviews === 0) issues.push({ code: "rev_missing_on_page", severity: "high", text: "We have Google reviews for this client but the live page doesn't show them.", fix: "Code or cache problem — tell dev." });
      }

      // 2. Every picture the page points at.
      const urls = [...servedImgs.slice(0, 6), ...(servedPic ? [servedPic] : [])];
      if (urls.length) {
        const oks = await Promise.all(urls.map((u) => imageOk(u)));
        const bad = urls.filter((_, i) => !oks[i]);
        if (bad.length) issues.push({ code: "ig_imgs_broken", severity: "high", text: `${bad.length} of ${urls.length} Instagram pictures on the page don't load — visitors see empty squares.`, fix: "Press Refresh from Instagram now in the CPD Instagram grid panel (re-saves the pictures)." });
      }

      // 3. What real visitors' browsers drew in the last 24 h.
      const reps = repBySlug.get(c.slug) ?? [];
      const renders = reps.filter((r) => r.kind === "render");
      const visitors = new Set(renders.map((r) => r.visitor_id)).size;
      const gridRenders = renders.filter((r) => r.grid_expected);
      const gridFails = gridRenders.filter((r) => (r.grid_tiles ?? 0) < 3);
      if (gridRenders.length >= 3 && gridFails.length * 2 >= gridRenders.length) issues.push({ code: "visitors_no_grid", severity: "high", text: `${gridFails.length} of ${gridRenders.length} visitors in the last 24 h did NOT see the Instagram grid.`, fix: "Engine problem — tell dev (the page has the grid but browsers don't draw it)." });
      const revRenders = renders.filter((r) => r.rev_expected);
      const revFails = revRenders.filter((r) => (r.rev_cards ?? 0) === 0);
      if (revRenders.length >= 3 && revFails.length * 2 >= revRenders.length) issues.push({ code: "visitors_no_reviews", severity: "high", text: `${revFails.length} of ${revRenders.length} visitors in the last 24 h did NOT see the Google reviews.`, fix: "Engine problem — tell dev." });
      const imgErrVisitors = new Set(reps.filter((r) => r.kind === "imgerr").map((r) => r.visitor_id));
      if (imgErrVisitors.size >= 2 && imgErrVisitors.size * 4 >= Math.max(visitors, 1)) issues.push({ code: "visitors_img_errors", severity: "high", text: `Instagram pictures failed to load for ${imgErrVisitors.size} visitor${imgErrVisitors.size === 1 ? "" : "s"} in the last 24 h.`, fix: "Press Refresh from Instagram now in the CPD Instagram grid panel." });
      const jsErr = reps.filter((r) => r.kind === "jserr");
      const jsVisitors = new Set(jsErr.map((r) => r.visitor_id)).size;
      if (jsVisitors >= 1) issues.push({ code: "visitors_js_error", severity: jsVisitors >= 2 ? "high" : "medium", text: `Drawing the ${/reviews/.test(jsErr[0]?.error ?? "") ? "Google reviews" : "Instagram grid"} crashed for ${jsVisitors} visitor${jsVisitors === 1 ? "" : "s"}: “${String(jsErr[0]?.error ?? "").slice(0, 120)}”.`, fix: "Code problem — tell dev. The booking step itself keeps working (the widget is skipped)." });

      // 4. The refresh jobs are still running.
      if (igExpected && !ex.igFrozen && daysSince(ex.igFetch?.at ?? ex.igFeed?.at) > STALE_DAYS) issues.push({ code: "ig_stale", severity: "medium", text: `Instagram pictures haven't refreshed in ${Math.round(daysSince(ex.igFetch?.at ?? ex.igFeed?.at))} days (should be every 13).`, fix: "The hourly Instagram refresh job may have stopped — tell dev; Refresh from Instagram now fixes this client meanwhile." });
      if (revExpected && daysSince(ex.gFetch?.at) > STALE_DAYS) issues.push({ code: "rev_stale", severity: "medium", text: `Google reviews haven't refreshed in ${Math.round(daysSince(ex.gFetch?.at))} days (should be every 13).`, fix: "The daily Google reviews job may have stopped — tell dev." });

      const pageUp = !issues.some((i) => i.code === "page_down");
      results.push({
        slug: c.slug, name, checked: true, visits: visitors,
        gridOk: pageUp && igExpected && servedImgs.length >= 3 && !issues.some((i) => /^ig_imgs|visitors_no_grid|visitors_img/.test(i.code)),
        reviewsOk: pageUp && revExpected && servedReviews > 0 && !issues.some((i) => i.code === "visitors_no_reviews"),
        issues, gaps,
      });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  let filed = 0, updated = 0, resolved = 0;
  const checked = results.filter((r) => r.checked);
  if (!opts.dry) {
    const { data: open } = await svc.from("alerts").select("id, source_key, detail").eq("type", "funnel_widgets").eq("status", "open");
    const openByKey = new Map((open ?? []).map((o) => [String(o.source_key), o as { id: string; detail: string | null }]));
    for (const r of checked) {
      const key = `widgets:${r.slug}`;
      if (!r.issues.length) {
        const o = openByKey.get(key);
        if (o) {
          await svc.from("alerts").update({ status: "resolved", resolved_by: "system (Instagram grid / Google reviews showing fine again)", resolved_at: new Date().toISOString() }).eq("id", o.id);
          resolved++;
        }
        continue;
      }
      const sev = r.issues.some((i) => i.severity === "high") ? "high" : "medium";
      const title = `${r.name}: ${r.issues.map((i) => (i.code.startsWith("rev") || i.code === "visitors_no_reviews" ? "Google reviews" : i.code === "page_down" ? "funnel page" : "Instagram grid")).filter((v, i, a) => a.indexOf(v) === i).join(" + ")} not working`;
      const detail = r.issues.map((i) => `• ${i.text}\n  What to do: ${i.fix}`).join("\n\n") + `\n\nFunnel: ${BASE}/f/${r.slug}?preview=booking`;
      const meta = { slug: r.slug, business: r.name, codes: r.issues.map((i) => i.code) };
      const o = openByKey.get(key);
      if (o) {
        if ((o.detail ?? "") !== detail) {
          await svc.from("alerts").update({ title: title.slice(0, 300), detail: detail.slice(0, 2000), severity: sev, meta }).eq("id", o.id);
          updated++;
        }
        continue;
      }
      // Re-open fresh (a resolved twin from earlier never suppresses a new breakage for long).
      const { data: twin } = await svc.from("alerts").select("id, muted, resolved_at, resolved_by").eq("type", "funnel_widgets").eq("source_key", key).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (twin?.muted) continue; // "don't show again"
      // Someone closed it by hand in the last day — give their fix a day before nagging again.
      if (twin && !/^system/i.test(String(twin.resolved_by ?? "")) && daysSince(twin.resolved_at) < 1) continue;
      const { error: insErr } = await svc.from("alerts").insert({ type: "funnel_widgets", severity: sev, title: title.slice(0, 300), detail: detail.slice(0, 2000), source_key: key, meta });
      if (!insErr) filed++;
    }
  }

  const summary = {
    checked: checked.length,
    skipped: results.length - checked.length,
    gridOk: checked.filter((r) => r.gridOk).length,
    reviewsOk: checked.filter((r) => r.reviewsOk).length,
    problems: checked.filter((r) => r.issues.length).length,
    visitReports: reports.length,
  };
  const details = {
    problems: checked.filter((r) => r.issues.length).map((r) => ({ slug: r.slug, name: r.name, issues: r.issues.map((i) => ({ code: i.code, severity: i.severity, text: i.text })) })),
    gaps: checked.flatMap((r) => r.gaps),
  };
  if (!opts.dry && !opts.slug) {
    await svc.from("funnel_health_runs").insert({ checked: summary.checked, grid_ok: summary.gridOk, reviews_ok: summary.reviewsOk, problems: summary.problems, details });
  }
  return { ...summary, filed, updated, resolved, details };
}
