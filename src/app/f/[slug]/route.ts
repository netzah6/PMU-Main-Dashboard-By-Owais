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
    metaPixelId: (row.config.metaPixelId || row.extras.metaPixelId || "").replace(/\D/g, ""),
  };
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
  const faqs = row.config.faqsRaw ? parseFaqs(row.config.faqsRaw) : row.extras.faqs ?? [];
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
<script src="/onebox.js?v=30" defer></script>
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
