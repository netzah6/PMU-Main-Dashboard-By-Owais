import { NextRequest } from "next/server";
import { waitUntil } from "@vercel/functions";
import { createServiceClient } from "@/lib/supabase/server";
import { refreshOneboxConfig, SYNC_TTL_MS } from "@/lib/onebox";
import { fetchProgramRows, findClientProgram } from "@/lib/client-program";
import { buildFunnelPage, lockFunnelPage, type FrozenPage, type OneboxRow as Row } from "@/lib/onebox-page";
import { frozenEngineSrc, liveEngineSrc } from "@/lib/onebox-engine";
import { signLogoUrl } from "@/lib/logo-sign";

// Public one-box funnel page: /f/<slug>, served as raw HTML (no React —
// the hosted engine public/onebox.js owns the DOM; a hydrated page would
// fight it). Config comes from onebox_clients, synced from the client's
// GHL custom values; extras hold FAQs, the Fanbasis block, Elfsight id.
export const dynamic = "force-dynamic";
/* The database moved to us-east-1 on 2026-09-19 (was Tokyo, which is why
   this route used to be pinned to hnd1). Default region = iad1, next to
   both the database and GHL — no pin needed any more. */
// Never serve cached fetches: Supabase rows and GHL availability must be live.
export const fetchCache = "force-no-store";

export async function GET(
  req: NextRequest,
  { params }: { params: { slug: string } }
) {
  const { slug } = params;
  const svc = createServiceClient();
  /* Auto-entry for same-funnel (page-1) tests, done INLINE: a visitor who
     lands on the plain funnel URL while an all-onebox experiment is running
     gets the sticky 50/50 coin flip right here — one request, no redirect
     hop (the earlier /f→/s→/f bounce cost first-time visitors 1.5-3s).
     Rules that keep this correct (each is load-bearing):
       · ob_e PRESENCE (not validity) skips the flip — post-splitter and
         preview links keep their explicit variant, and stale AI-follow-up
         links keep their old page.
       · ?preview is the team's thank-you preview — never enter the test.
       · Link scrapers get the control page (no assignment-row churn).
       · Experiments with an external side keep splitter-entry-only
         behavior — a bookmark must never see the client's old funnel.
       · Every during-test plain-URL response is no-store: it is
         per-visitor (variant + Set-Cookie) or a scraper's control copy,
         and the funnel-host cache key is shared by everyone.
       · Stickiness is per EXPERIMENT (cookie ob_v_<slug> = id:vkey:expId,
         same format /s writes) — a cookie minted under an earlier test
         re-rolls as a brand-new visitor, matching the splitter. */
  const ua = req.headers.get("user-agent") ?? "";
  const isBot = /facebookexternalhit|AdsBot|ob-warm/i.test(ua);
  const obE = req.nextUrl.searchParams.get("ob_e") ?? "";
  const obV = req.nextUrl.searchParams.get("ob_v") ?? "";
  // pay = a returning lead's payment link (/<slug>/confirm rewrites here
  // with the x-ob-pay header; ?pay=1 covers direct/local use) — never
  // re-enter an A/B split for someone who is coming back to pay.
  const isPay = req.headers.get("x-ob-pay") === "1" || req.nextUrl.searchParams.has("pay");
  const wantsSplit = !req.nextUrl.searchParams.has("ob_e") && !req.nextUrl.searchParams.has("preview") && !isPay;
  type ProbeVar = { vkey: string; kind: string; weight: number; config_override: Record<string, string> | null };
  /* Timeline screen: ?preview=…&fzv=<id>&fzs=<signature> shows a saved version.
     Only with ?preview= (the same test the engine uses to stay strictly read-only)
     and a link from that screen, so content taken off a page doesn't stay public. */
  const fzv = /[?&]preview=/.test(req.nextUrl.search) ? req.nextUrl.searchParams.get("fzv") ?? "" : "";
  const savedVersion = /^\d+$/.test(fzv) && signLogoUrl(`fzv:${fzv}`) && req.nextUrl.searchParams.get("fzs") === signLogoUrl(`fzv:${fzv}`) ? fzv : "";
  const [clientRes, expRes, paramVarRes, savedRes] = await Promise.all([
    svc.from("onebox_clients").select("*").eq("slug", slug).single(),
    wantsSplit
      ? svc.from("onebox_experiments").select("id, onebox_variants(vkey, kind, weight, config_override)")
          .eq("slug", slug).eq("status", "running")
          .order("created_at", { ascending: false }).limit(1).maybeSingle()
      : Promise.resolve({ data: null }),
    /* Explicit ?ob_e&ob_v (splitter / preview links): one embedded query
       replaces the old two sequential lookups — the join also carries the
       experiment's slug so ownership is still enforced. */
    /^\d+$/.test(obE) && obV
      ? svc.from("onebox_variants").select("config_override, kind, onebox_experiments!inner(slug)")
          .eq("experiment_id", Number(obE)).eq("vkey", obV).maybeSingle()
      : Promise.resolve({ data: null }),
    savedVersion
      ? svc.from("funnel_versions").select("engine, page").eq("id", Number(savedVersion)).eq("slug", slug).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const row = clientRes.data as Row | null;
  if (!row || row.status === "draft") {
    return new Response("Not found", { status: 404 });
  }
  const saved = savedRes.data as { engine: number; page: FrozenPage } | null;
  const frozenEngine = saved?.engine ?? row.frozen_engine ?? null;
  const frozenPage = saved?.page ?? row.frozen_page ?? null;
  const exp = (frozenEngine ? null : expRes.data) as { id: number; onebox_variants: ProbeVar[] } | null;
  const expVars = exp?.onebox_variants ?? [];
  // [].every() is vacuously true — a variantless running row is not a test.
  const testLive = !!exp && expVars.length > 0 && expVars.every((v) => v.kind === "onebox");
  /* Any running test makes the plain URL per-visitor (a coin flip, or the
     cookie attribution below), so it must never enter the shared cache. */
  const uncacheable = !!exp && expVars.length > 0;
  let flip: { expId: number; vkey: string; override: Record<string, string>; cookie: string; resume?: boolean } | null = null;
  if (testLive && !isBot && exp) {
    const raw = req.cookies.get(`ob_v_${slug}`)?.value ?? "";
    const [cid, cvkey, cexp] = raw.split(":");
    const sameExp = !!cid && cexp === String(exp.id);
    const vid = sameExp ? cid : crypto.randomUUID();
    let chosen = (sameExp && cvkey && expVars.find((v) => v.vkey === cvkey)) || null;
    const isNew = !chosen;
    if (!chosen) {
      // Mirror /s's pick exactly (vkey order, first variant on zero total) so
      // both entry paths agree even on a misconfigured all-zero-weight test.
      const ordered = [...expVars].sort((a, b) => a.vkey.localeCompare(b.vkey));
      const total = ordered.reduce((s, v) => s + Math.max(0, v.weight ?? 0), 0);
      chosen = ordered[0];
      if (total > 0) {
        let n = Math.random() * total;
        for (const v of ordered) { n -= Math.max(0, v.weight ?? 0); if (n <= 0) { chosen = v; break; } }
      }
    }
    if (isNew) {
      // Off the visitor's clock; waitUntil keeps the lambda alive until it lands.
      waitUntil(Promise.resolve(
        svc.from("onebox_assignments")
          .upsert({ experiment_id: exp.id, vkey: chosen.vkey, visitor_id: vid },
                  { onConflict: "experiment_id,visitor_id", ignoreDuplicates: true })
          .then(() => {})
      ));
    }
    flip = { expId: exp.id, vkey: chosen.vkey, override: chosen.config_override ?? {}, cookie: `${vid}:${chosen.vkey}:${exp.id}` };
  }
  /* External-vs-one-box test: a visitor the splitter already put on the
     one-box side who comes back on the plain URL (history, bookmark, a
     re-typed address) keeps that attribution — no re-roll, no redirect, no
     new assignment row — so their lead lands on the side that earned it.
     Without this the lead row carried no experiment at all (Oct 19: 2 of
     11 one-box leads, which made "scheduled a call" exceed "leads"). */
  if (!flip && exp && expVars.length > 0 && !testLive && !isBot) {
    const raw = req.cookies.get(`ob_v_${slug}`)?.value ?? "";
    const [cid, cvkey, cexp] = raw.split(":");
    const v = cid && cexp === String(exp.id) ? expVars.find((x) => x.vkey === cvkey && x.kind === "onebox") : undefined;
    if (v) flip = { expId: exp.id, vkey: v.vkey, override: v.config_override ?? {}, cookie: raw, resume: true };
  }

  /* Resync from GHL when the stored copy is stale — but never on the
     visitor's clock. Awaiting this made one visitor every few minutes
     wait out a full GHL round trip; they now get the current config and
     the refresh lands for the next request. Only a funnel that has never
     synced blocks, because it has nothing to show otherwise. */
  const isB2B = row.extras?.template === "b2b";
  const age = row.cv_synced_at ? Date.now() - new Date(row.cv_synced_at).getTime() : Infinity;
  // B2B content lives in extras.b2b, not in GHL custom values — never sync.
  if (age > SYNC_TTL_MS && !isB2B) {
    const refresh = refreshOneboxConfig(svc, row.slug, row.location_id);
    if (!row.cv_synced_at) {
      const fresh = await refresh;
      if (fresh) row.config = fresh;
    } else {
      /* Vercel freezes the lambda once the response returns, killing a
         bare fire-and-forget promise — custom-value edits then never
         reached the funnel until some lucky warm invocation finished
         the job (bitten 2026-08-23: deleted photo CVs kept serving).
         waitUntil keeps the function alive until the refresh lands,
         still off the visitor's clock. */
      waitUntil(refresh.then(() => {}).catch(() => {}));
    }
  }

  /* Funnel-vs-funnel testing: when the splitter (or a preview link)
     appends ob_e/ob_v, merge that variant's overrides over the config so
     the same slug can render different headlines, offers or copy. The
     experiment must belong to this slug — otherwise ignore. */
  const variantOverrides: Record<string, string> = {};
  const paramVar = (frozenEngine ? null : paramVarRes.data) as { config_override: Record<string, unknown> | null; onebox_experiments: { slug: string } } | null;
  if (paramVar && paramVar.onebox_experiments?.slug === slug) {
    const override = (paramVar.config_override ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(override)) {
      if (typeof v === "string" && v.trim()) {
        row.config[k] = v;
        variantOverrides[k] = v;
      }
    }
  }
  /* The inline coin flip's variant, same merge rules as the param path. */
  if (flip) {
    for (const [k, v] of Object.entries(flip.override)) {
      if (typeof v === "string" && v.trim()) {
        row.config[k] = v;
        variantOverrides[k] = v;
      }
    }
  }
  const expId = flip ? String(flip.expId) : frozenEngine ? "" : req.nextUrl.searchParams.get("ob_e") ?? "";
  const expVkey = flip ? flip.vkey : frozenEngine ? "" : req.nextUrl.searchParams.get("ob_v") ?? "";
  /* Per-visitor / mid-test responses must never enter the shared CDN cache. */
  const respHeaders = (base: Record<string, string>): Record<string, string> => {
    const h = { ...base };
    if (uncacheable) h["Cache-Control"] = "no-store";
    if (flip && !flip.resume) h["Set-Cookie"] = `ob_v_${slug}=${encodeURIComponent(flip.cookie)}; Max-Age=31536000; Path=/; SameSite=Lax`;
    return h;
  };

  if (isB2B) return serveB2B(row, req, variantOverrides, { expId, expVkey, respHeaders });

  const page = buildFunnelPage(row, { expId, expVkey, isPay });
  if (frozenEngine && frozenPage) lockFunnelPage(page, frozenPage);
  const { cfg, faqs, title, logoPreload, fanbasisHtml } = page;
  /* Program-driven flow: a (V1) client's funnel is survey → thank-you
     ONLY — no booking page, no deposit page. The program comes from the
     same Clients Master row the dashboard's V3/V1 switcher edits, so
     flipping it there changes this page too (within the ~1-min cache).
     V3 (and anything unmatched) keeps the full flow. A frozen funnel keeps
     the page it was frozen on: the Freeze screen flags the label instead. */
  if (!row.frozen_engine) {
    try {
      const prog = findClientProgram(await fetchProgramRows(svc), String(row.client_name ?? ""));
      if (prog?.version === "(V1)") cfg.flow = "v1";
    } catch { /* the funnel must render even if the sheet mirror is down */ }
  }
  const boot = (
    `window.OB_CONFIG=${JSON.stringify(cfg)};` +
    `window.OB_FAQS=${JSON.stringify(faqs)};`
  ).replace(/</g, "\\u003c");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>${title.replace(/[<>&]/g, "")}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&family=Lato:wght@400;700&family=Inter:wght@400;600&display=swap" media="print" onload="this.media='all'">
<noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&family=Lato:wght@400;700&family=Inter:wght@400;600&display=swap"></noscript>
${logoPreload ? `<link rel="preload" as="image" href="${logoPreload}" fetchpriority="high">` : ""}
${isPay ? `<script>window.OB_PAYFETCH=(function(){try{var t=new URLSearchParams(location.search).get("t");if(!t){var m=location.pathname.match(/\\/([A-Za-z0-9]{8,40})\\/(confirm|last-step)\\/?$/);if(m)t=m[1];}if(!t)return null;return fetch("/api/onebox/paylead?slug=${row.slug}&t="+encodeURIComponent(t)).then(function(r){return r.ok?r.json():null}).catch(function(){return null});}catch(e){return null}})();</script>` : ""}
${frozenEngine
  /* Never a blank page: if the saved copy can't load, run the live engine. */
  ? `<script src="${frozenEngineSrc(frozenEngine)}" defer onerror="var s=document.createElement('script');s.src='${liveEngineSrc}';document.head.appendChild(s)"></script>`
  : `<script src="${liveEngineSrc}" defer></script>`}
</head>
<body style="margin:0">
${isPay ? `<div id="ob-pay-veil" style="position:fixed;inset:0;z-index:9999;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:Inter,system-ui,sans-serif"><p style="margin:0 0 6px;font-weight:700;font-size:18px">One moment&hellip;</p><p style="margin:0;color:#667">Loading your reservation</p></div>` : ""}
<div id="onebox-root"></div>
<script>${boot}</script>
${fanbasisHtml ? `<template id="onebox-fanbasis-holder">${fanbasisHtml}</template>` : ""}
</body>
</html>`;

  return new Response(html, {
    headers: respHeaders({
      "Content-Type": "text/html; charset=utf-8",
      /* Served from the CDN for a minute, then refreshed in the
         background — visitors get an edge hit instead of a database
         round trip. Dashboard saves re-warm the edge within ~2-3 min;
         a GHL-direct edit shows up visitor-driven, worst case ~1h on a
         quiet funnel. respHeaders swaps in no-store (and the sticky
         cookie) while a page-1 test is running for the slug. */
      "Cache-Control": "public, s-maxage=60, stale-while-revalidate=3600, stale-if-error=86400",
    }),
  });
}

/* The agency's B2B (artist-acquisition) funnel. Content and settings come
   from extras.b2b — dashboard-managed, out of the CV sync's reach — and
   the page runs its own engine. Split-test overrides still apply, so
   copy variants work the same way as on client funnels. */
type AbServe = { expId: string; expVkey: string; respHeaders: (base: Record<string, string>) => Record<string, string> };
function serveB2B(row: Row, req: NextRequest, variantOverrides: Record<string, string>, ab: AbServe) {
  const cfg: Record<string, string> = {
    ...(row.extras.b2b ?? {}),
    ...variantOverrides,
    slug: row.slug,
    locationId: row.location_id,
    submitUrl: "/api/onebox/submit",
    experimentId: ab.expId,
    variantKey: ab.expVkey,
  };
  const boot = `window.OB_CONFIG=${JSON.stringify(cfg)};`.replace(/</g, "\\u003c");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>PMU Bookings On Demand — Check Availability</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700;800&family=Lato:wght@400;700&display=swap" media="print" onload="this.media='all'">
<noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700;800&family=Lato:wght@400;700&display=swap"></noscript>
<script src="/onebox-b2b.js?v=16" defer></script>
</head>
<body style="margin:0">
<div id="onebox-root"></div>
<script>${boot}</script>
</body>
</html>`;
  return new Response(html, {
    headers: ab.respHeaders({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, s-maxage=60, stale-while-revalidate=3600, stale-if-error=86400",
    }),
  });
}
