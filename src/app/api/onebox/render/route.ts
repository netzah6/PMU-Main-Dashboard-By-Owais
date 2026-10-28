import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

export const fetchCache = "force-no-store";

/* Public render beacon (owner, 10/28/2026: "make sure the Instagram widget
   and Google reviews work"). The funnel engine reports what a real visitor's
   browser actually drew on the booking step — Instagram grid tiles, Google
   review cards — plus any of those pictures that failed to load and any
   error while drawing them. The funnel-health cron reads it; nothing here
   changes a funnel. One row per visitor / funnel / day / kind (/ picture),
   so refreshes and repeats are free. Accepts sendBeacon's text/plain body. */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const slug = String(body.slug ?? "").slice(0, 100);
  const visitorId = String(body.visitorId ?? "").slice(0, 64);
  const kind = String(body.kind ?? "");
  if (!slug || !/^[a-z0-9-]+$/.test(slug) || !visitorId || !["render", "imgerr", "jserr"].includes(kind)) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const int = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(99, Math.round(Number(v)))) : null);
  const url = kind === "imgerr" ? String(body.url ?? "").slice(0, 500) : null;
  if (kind === "imgerr" && !/^https:\/\//.test(url ?? "")) return NextResponse.json({ ok: false }, { status: 400 });
  const error = kind === "jserr" ? String(body.error ?? "").slice(0, 300) : null;
  const svc = createServiceClient();
  await svc
    .from("onebox_render_reports")
    .upsert(
      {
        slug,
        visitor_id: visitorId,
        kind,
        engine_v: String(body.v ?? "").slice(0, 12) || null,
        grid_expected: kind === "render" ? !!body.gridExpected : null,
        grid_tiles: kind === "render" ? int(body.gridTiles) : null,
        rev_expected: kind === "render" ? !!body.revExpected : null,
        rev_cards: kind === "render" ? int(body.revCards) : null,
        url,
        error,
        dedupe: kind === "imgerr" ? (url ?? "") : kind === "jserr" ? (error ?? "").slice(0, 80) : "",
      },
      { onConflict: "slug,visitor_id,day,kind,dedupe", ignoreDuplicates: true }
    )
    .then(() => {});
  return NextResponse.json({ ok: true });
}
