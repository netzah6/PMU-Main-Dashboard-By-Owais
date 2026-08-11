import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

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
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
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

  const cfg = {
    ...row.config,
    slug: row.slug,
    locationId: row.location_id,
    submitUrl: "/api/onebox/submit",
    fanbasisSelector: "#fanbasis-checkout-wrapper",
    elfsightId: row.extras.elfsightId ?? "",
    resultImgs: row.extras.resultImgs ?? "",
  };
  const title = `${row.client_name || cfg.biz || "Book"} — Claim Your Offer`;
  // </script> inside the JSON payloads must not terminate the script tag.
  const boot = (
    `window.OB_CONFIG=${JSON.stringify(cfg)};` +
    `window.OB_FAQS=${JSON.stringify(row.extras.faqs ?? [])};`
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
<script src="/onebox.js" async></script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
