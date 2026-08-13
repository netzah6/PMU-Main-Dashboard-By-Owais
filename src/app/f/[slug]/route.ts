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

  // Auto-resync from GHL when the stored copy is stale, so the team can
  // edit custom values in GHL and see the funnel update within minutes.
  const age = row.cv_synced_at ? Date.now() - new Date(row.cv_synced_at).getTime() : Infinity;
  if (age > SYNC_TTL_MS) {
    const fresh = await refreshOneboxConfig(svc, row.slug, row.location_id);
    if (fresh) row.config = fresh;
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
</head>
<body style="margin:0">
<div id="onebox-root"></div>
<script>${boot}</script>
${fanbasisHtml ? `<template id="onebox-fanbasis-holder">${fanbasisHtml}</template>` : ""}
<script src="/onebox.js?v=27" async></script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
