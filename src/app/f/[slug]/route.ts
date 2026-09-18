import { NextRequest } from "next/server";
import { waitUntil } from "@vercel/functions";
import { createServiceClient } from "@/lib/supabase/server";
import { refreshOneboxConfig, parseFaqs, normalizeElfsight, buildFanbasisBlock, SYNC_TTL_MS } from "@/lib/onebox";
import { fetchProgramRows, findClientProgram } from "@/lib/client-program";
import { signLogoUrl } from "@/lib/logo-sign";

// Public one-box funnel page: /f/<slug>, served as raw HTML (no React —
// the hosted engine public/onebox.js owns the DOM; a hydrated page would
// fight it). Config comes from onebox_clients, synced from the client's
// GHL custom values; extras hold FAQs, the Fanbasis block, Elfsight id.
export const dynamic = "force-dynamic";
/* The database lives in ap-northeast-1 (Tokyo); an unpinned function runs
   in US East and pays ~300ms per DB roundtrip. Run next to the data — the
   visitor pays one slightly longer edge hop instead of 2-3 Pacific ones.
   Scoped to this route only: GHL-heavy crons must stay near GHL (US). */
export const preferredRegion = "hnd1";
// Never serve cached fetches: Supabase rows and GHL availability must be live.
export const fetchCache = "force-no-store";

type Row = {
  slug: string;
  location_id: string;
  client_name: string;
  status: string;
  cv_synced_at: string | null;
  config: Record<string, string>;
  extras: {
    faqs?: { q: string; a: string }[];
    fanbasisHtml?: string;
    elfsightId?: string;
    resultImgs?: string;
    metaPixelId?: string;
    /* "video" = this client's calendar slot is a video consultation, not an
       in-studio visit — the engine reframes its wording (Brows By Kali). */
    consultMode?: string;
    /* "b2b" = the agency's own artist-acquisition funnel: config lives in
       extras.b2b (the CV sync must never overwrite it) and the page runs
       the dedicated onebox-b2b.js engine — no Fanbasis, booking a free
       discovery call is the conversion. */
    template?: string;
    b2b?: Record<string, string>;
  };
};

/* The agency template's six FAQs, each with its educational video from the
   shared media library (same mp4s the original GHL funnels play). Used when
   a funnel has no custom "OB - FAQs" value; `v` = video, `p` = poster. */
const VID = "https://assets.cdn.filesafe.space/SfpNMJ5YU9lBkxss47lK/media/";
const POSTER = "https://assets.cdn.filesafe.space/asaIf2fxizaCNJ71iywk/media/";
const DEFAULT_FAQS = [
  {
    q: "What is permanent makeup❓",
    a: "Permanent makeup is a beauty treatment that gently enhances your natural features — like your brows, eyeliner, or lips — so you can wake up looking polished every day without the hassle of applying makeup.",
    v: `${VID}68c0184afbf3b661efb41406.mp4`, p: `${POSTER}68c1db88c6b38068da8f9581.png`,
  },
  {
    q: "Is permanent makeup the same as tattooing❓",
    a: "No. Permanent makeup is a much softer and more natural technique. Unlike traditional tattoos, the colors are designed to fade gradually over time, keeping the look fresh and allowing adjustments as your style changes.",
    v: `${VID}68c0184ae123d76c6b6c6673.mp4`, p: `${POSTER}68c1db884ab6400a06e50aec.png`,
  },
  {
    q: "Is it painless, or does it cause discomfort❓",
    a: "Clients are pleasantly surprised at how comfortable the process is. A numbing cream is used to make the treatment as easy and relaxing as possible. Many say it feels more like light scratching than anything else.",
    v: `${VID}68c0184af6b49a816f679b73.mp4`, p: `${POSTER}68c1db8848a4feab1bfea334.png`,
  },
  {
    q: "How long does the procedure take to complete❓",
    a: "The session usually takes 1.5–3 hours, which includes consultation, shaping, color selection, and the procedure itself. It's an unhurried, detailed process to make sure you leave with results you'll love.",
    v: `${VID}68c016527f917b8ce68b5fca.mp4`, p: `${POSTER}68c1db8848a4fe6f9cfea333.png`,
  },
  {
    q: "Is permanent makeup a safe procedure❓",
    a: "Yes. When done by a trained professional, permanent makeup is a safe and hygienic procedure. Certified artists use high-quality products and follow strict safety standards, so you can feel completely at ease.",
    v: `${VID}68c0165be123d775576bd606.mp4`, p: `${POSTER}68c1db8844a66348a21b9888.png`,
  },
  {
    q: "Is any care required after the procedure❓",
    a: "Yes, but it's simple! We'll guide you step by step. Typically, you'll just need to keep the area clean, avoid touching it too much, and let it heal naturally. Following these easy instructions helps ensure your results stay beautiful and long-lasting.",
    v: `${VID}68c0165b32f3397225cd7e22.mp4`, p: `${POSTER}68c1db886880bf89fcdb88ea.png`,
  },
];

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
  const [clientRes, expRes, paramVarRes] = await Promise.all([
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
  ]);
  const row = clientRes.data as Row | null;
  if (!row || row.status === "draft") {
    return new Response("Not found", { status: 404 });
  }
  const exp = expRes.data as { id: number; onebox_variants: ProbeVar[] } | null;
  const expVars = exp?.onebox_variants ?? [];
  // [].every() is vacuously true — a variantless running row is not a test.
  const testLive = !!exp && expVars.length > 0 && expVars.every((v) => v.kind === "onebox");
  const uncacheable = testLive;
  let flip: { expId: number; vkey: string; override: Record<string, string>; cookie: string } | null = null;
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
  const paramVar = paramVarRes.data as { config_override: Record<string, unknown> | null; onebox_experiments: { slug: string } } | null;
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
  const expId = flip ? String(flip.expId) : req.nextUrl.searchParams.get("ob_e") ?? "";
  const expVkey = flip ? flip.vkey : req.nextUrl.searchParams.get("ob_v") ?? "";
  /* Per-visitor / mid-test responses must never enter the shared CDN cache. */
  const respHeaders = (base: Record<string, string>): Record<string, string> => {
    const h = { ...base };
    if (uncacheable) h["Cache-Control"] = "no-store";
    if (flip) h["Set-Cookie"] = `ob_v_${slug}=${encodeURIComponent(flip.cookie)}; Max-Age=31536000; Path=/; SameSite=Lax`;
    return h;
  };

  if (isB2B) return serveB2B(row, req, variantOverrides, { expId, expVkey, respHeaders });

  const cfg: Record<string, string> = {
    ...row.config,
    slug: row.slug,
    locationId: row.location_id,
    submitUrl: "/api/onebox/submit",
    experimentId: expId,
    variantKey: expVkey,
    fanbasisSelector: "#fanbasis-checkout-wrapper",
    igWidget: normalizeElfsight(row.config.igWidget || row.config.elfsightId || row.extras.elfsightId || ""),
    googleWidget: normalizeElfsight(row.config.googleWidget || ""),
    resultImgs: row.config.resultImgs || row.extras.resultImgs || "",
    studioImgs: row.config.studioImgs || "",
    metaPixelId: (row.config.metaPixelId || row.extras.metaPixelId || "").replace(/\D/g, ""),
    surveyRaw: row.config.surveyRaw || "",
    consultMode: row.extras.consultMode || "",
    pay: isPay ? "1" : "",
  };
  /* Program-driven flow: a (V1) client's funnel is survey → thank-you
     ONLY — no booking page, no deposit page. The program comes from the
     same Clients Master row the dashboard's V3/V1 switcher edits, so
     flipping it there changes this page too (within the ~1-min cache).
     V3 (and anything unmatched) keeps the full flow. */
  try {
    const prog = findClientProgram(await fetchProgramRows(svc), String(row.client_name ?? ""));
    if (prog?.version === "(V1)") cfg.flow = "v1";
  } catch { /* the funnel must render even if the sheet mirror is down */ }
  /* Same URL the engine will render (its fastImg proxies media-library
     files) so the preload warms the right resource, never a second one. */
  const logoRaw = (cfg.logo || "").replace(/["\\]/g, "");
  const logoFast = !logoRaw ? ""
    : /^https:\/\/(assets\.cdn\.filesafe\.space|storage\.googleapis\.com\/msgsndr)\//.test(logoRaw)
      ? `https://images.leadconnectorhq.com/image/f_webp/q_80/r_320/u_${logoRaw}`
      : logoRaw;
  /* Serve the logo through our own immutable caching proxy: GHL's image
     service costs ~0.3-1.2s per request; behind /api/onebox/logo the first
     visitor per edge region warms it and everyone after gets ~30ms. The
     engine's fastImg passes relative URLs through untouched, so cfg.logo
     can carry the proxied form. A changed logo changes the source URL,
     which changes the proxy URL — immutability is safe. */
  const logoSig = logoFast ? signLogoUrl(logoFast) : "";
  const logoPreload = logoFast && logoSig && /^https:\/\/(images\.leadconnectorhq\.com|assets\.cdn\.filesafe\.space|storage\.googleapis\.com\/msgsndr|services\.leadconnectorhq\.com)\//.test(logoFast)
    ? `/api/onebox/logo?u=${encodeURIComponent(logoFast)}&s=${logoSig}`
    : logoFast;
  if (logoPreload) cfg.logo = logoPreload;
  const title = `${row.client_name || cfg.biz || "Book"} — Claim Your Offer`;
  // </script> inside the JSON payloads must not terminate the script tag.
  // Fanbasis block, in order of preference:
  //   1. product id  (the simple way — CC - Fanbasis Product ID)
  //   2. the whole pasted block (CC - Fanbasis Checkout Code)
  //   3. the Extras paste
  // Any relative thank-you path is made absolute to pmu-care.com.
  const absThankYou = (p: string) =>
    !p ? "" : /^https?:\/\//i.test(p) ? p : `https://pmu-care.com/${p.replace(/^\/+/, "")}`;
  let fanbasisHtml = "";
  const productId = (row.config.fanbasisProductId || "").trim();
  if (productId) {
    fanbasisHtml = buildFanbasisBlock(productId, absThankYou((row.config.thankYouPath || "").trim()));
  } else {
    fanbasisHtml = (row.config.fanbasisCode || "").trim() || row.extras.fanbasisHtml || "";
    if (fanbasisHtml) {
      fanbasisHtml = fanbasisHtml.replace(
        /REDIRECT_URL\s*=\s*'([^']*)'/,
        (m, u: string) => /^https?:\/\//i.test(u) ? m : `REDIRECT_URL = '${absThankYou(u)}'`
      );
    }
  }
  const customFaqs = row.config.faqsRaw ? parseFaqs(row.config.faqsRaw) : row.extras.faqs ?? [];
  const faqs = customFaqs.length ? customFaqs : DEFAULT_FAQS;
  const boot = (
    `window.OB_CONFIG=${JSON.stringify(cfg)};` +
    `window.OB_FAQS=${JSON.stringify(faqs)};`
  ).replace(/<\//g, "<\\/");

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
${isPay ? `<script>window.OB_PAYFETCH=(function(){try{var t=new URLSearchParams(location.search).get("t");if(!t)return null;return fetch("/api/onebox/paylead?slug=${row.slug}&t="+encodeURIComponent(t)).then(function(r){return r.ok?r.json():null}).catch(function(){return null});}catch(e){return null}})();</script>` : ""}
<script src="/onebox.js?v=79" defer></script>
</head>
<body style="margin:0">
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
  const boot = `window.OB_CONFIG=${JSON.stringify(cfg)};`.replace(/<\//g, "<\\/");
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
<script src="/onebox-b2b.js?v=4" defer></script>
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
