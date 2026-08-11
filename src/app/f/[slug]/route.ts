import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { refreshOneboxConfig, parseFaqs, SYNC_TTL_MS } from "@/lib/onebox";

// Public one-box funnel page: /f/<slug>, served as raw HTML (no React —
// the hosted engine public/onebox.js owns the DOM; a hydrated page would
// fight it). Config comes from onebox_clients, synced from the client's
// GHL custom values; extras hold FAQs, the Fanbasis block, Elfsight id.
export const dynamic = "force-dynamic";

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
  };
};

export async function GET(
  _req: NextRequest,
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
    fanbasisSelector: "#fanbasis-checkout-wrapper",
    elfsightId: row.config.elfsightId || row.extras.elfsightId || "",
    resultImgs: row.config.resultImgs || row.extras.resultImgs || "",
  };
  const title = `${row.client_name || cfg.biz || "Book"} — Claim Your Offer`;
  // </script> inside the JSON payloads must not terminate the script tag.
  const faqs = row.config.faqsRaw ? parseFaqs(row.config.faqsRaw) : row.extras.faqs ?? [];
  const boot = (
    `window.OB_CONFIG=${JSON.stringify(cfg)};` +
    `window.OB_FAQS=${JSON.stringify(faqs)};`
  ).replace(/<\//g, "<\\/");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/[<>&]/g, "")}</title>
</head>
<body style="margin:0">
<div id="onebox-root"></div>
<script>${boot}</script>
${row.extras.fanbasisHtml ? `<div style="display:none" id="onebox-fanbasis-holder">${row.extras.fanbasisHtml}</div>` : ""}
<script src="/onebox.js?v=8" async></script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
