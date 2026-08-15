import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

export const fetchCache = "force-no-store";

// Public visit beacon. The funnel page is CDN-cached, so the server never
// sees every view — the engine reports one hit per visitor instead, and
// the unique index makes refreshes free. One visitor = one row per day.
export async function POST(req: NextRequest) {
  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const slug = String(body.slug ?? "").slice(0, 100);
  const visitorId = String(body.visitorId ?? "").slice(0, 64);
  if (!slug || !visitorId || !/^[a-z0-9-]+$/.test(slug)) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const expIdRaw = String(body.experimentId ?? "").replace(/\D/g, "");
  const svc = createServiceClient();
  await svc
    .from("onebox_hits")
    .upsert(
      {
        slug,
        visitor_id: visitorId,
        experiment_id: expIdRaw ? Number(expIdRaw) : null,
        variant_key: String(body.variantKey ?? "").slice(0, 12) || null,
      },
      { onConflict: "slug,visitor_id,day", ignoreDuplicates: true }
    )
    .then(() => {});
  return NextResponse.json({ ok: true });
}
