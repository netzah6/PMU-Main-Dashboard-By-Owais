import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { refreshOneboxConfig, parseFaqs, normalizeElfsight, buildFanbasisBlock, SYNC_TTL_MS } from "@/lib/onebox";

// Public one-box funnel page: /f/<slug>, served as raw HTML (no React —
// the hosted engine public/onebox.js owns the DOM; a hydrated page would
// fight it). Config comes from onebox_clients, synced from the client's
// GHL custom values; extras hold FAQs, the Fanbasis block, Elfsight id.
export const dynamic = "force-dynamic";
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
  const { data } = await svc
    .from("onebox_clients")
    .select("*")
    .eq("slug", slug)
    .single();
  const row = data as Row | null;
  if (!row || row.status === "draft") {
    return new Response("Not found", { status: 404 });
  }

  /* Resync from GHL when the stored copy is stale — but never on the
     visitor's clock. Awaiting this made one visitor every few minutes
     wait out a full GHL round trip; they now get the current config and
     the refresh lands for the next request. Only a funnel that has never
     synced blocks, because it has nothing to show otherwise. */
  const age = row.cv_synced_at ? Date.now() - new Date(row.cv_synced_at).getTime() : Infinity;
  if (age > SYNC_TTL_MS) {
    const refresh = refreshOneboxConfig(svc, row.slug, row.location_id);
    if (!row.cv_synced_at) {
      const fresh = await refresh;
      if (fresh) row.config = fresh;
    } else {
      refresh.catch(() => {});
    }
  }

  /* Funnel-vs-funnel testing: when the splitter (or a preview link)
     appends ob_e/ob_v, merge that variant's overrides over the config so
     the same slug can render different headlines, offers or copy. The
     experiment must belong to this slug — otherwise ignore. */
  const obE = req.nextUrl.searchParams.get("ob_e") ?? "";
  const obV = req.nextUrl.searchParams.get("ob_v") ?? "";
  if (/^\d+$/.test(obE) && obV) {
    const { data: ex } = await svc
      .from("onebox_experiments")
      .select("slug")
      .eq("id", Number(obE))
      .maybeSingle();
    if (ex?.slug === slug) {
      const { data: variant } = await svc
        .from("onebox_variants")
        .select("config_override, kind")
        .eq("experiment_id", Number(obE))
        .eq("vkey", obV)
        .maybeSingle();
      const override = (variant?.config_override ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(override)) {
        if (typeof v === "string" && v.trim()) row.config[k] = v;
      }
    }
  }

  const cfg: Record<string, string> = {
    ...row.config,
    slug: row.slug,
    locationId: row.location_id,
    submitUrl: "/api/onebox/submit",
    experimentId: req.nextUrl.searchParams.get("ob_e") ?? "",
    variantKey: req.nextUrl.searchParams.get("ob_v") ?? "",
    fanbasisSelector: "#fanbasis-checkout-wrapper",
    igWidget: normalizeElfsight(row.config.igWidget || row.config.elfsightId || row.extras.elfsightId || ""),
    googleWidget: normalizeElfsight(row.config.googleWidget || ""),
    resultImgs: row.config.resultImgs || row.extras.resultImgs || "",
    studioImgs: row.config.studioImgs || "",
    metaPixelId: (row.config.metaPixelId || row.extras.metaPixelId || "").replace(/\D/g, ""),
  };
  /* Same URL the engine will render (its fastImg proxies media-library
     files) so the preload warms the right resource, never a second one. */
  const logoRaw = (cfg.logo || "").replace(/["\\]/g, "");
  const logoPreload = !logoRaw ? ""
    : /^https:\/\/(assets\.cdn\.filesafe\.space|storage\.googleapis\.com\/msgsndr)\//.test(logoRaw)
      ? `https://images.leadconnectorhq.com/image/f_webp/q_80/r_320/u_${logoRaw}`
      : logoRaw;
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
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&family=Lato:wght@400;700&family=Inter:wght@400;600&display=swap">
${logoPreload ? `<link rel="preload" as="image" href="${logoPreload}" fetchpriority="high">` : ""}
<script src="/onebox.js?v=49" defer></script>
</head>
<body style="margin:0">
<div id="onebox-root"></div>
<script>${boot}</script>
${fanbasisHtml ? `<template id="onebox-fanbasis-holder">${fanbasisHtml}</template>` : ""}
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      /* Served from the CDN for a minute, then refreshed in the
         background — visitors get an edge hit instead of a database
         round trip, and a custom-value edit still appears within the
         same ~5 minutes as before. */
      "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
    },
  });
}
