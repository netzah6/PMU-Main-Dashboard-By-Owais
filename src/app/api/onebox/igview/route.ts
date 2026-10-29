import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";

export const fetchCache = "force-no-store";

/* Public slider beacon (owner, 10/29/2026: "do visitors tap a post and keep
   swiping — should the slider hold more than 12?"). The funnel engine sends
   the visitor's running totals for the day each time they close the
   Instagram slider or leave the page; one row per visitor / funnel / day,
   overwritten with the newest totals. Joined to leads by visitor_id, it
   shows whether swiping deeper goes with picking a time / paying. Accepts
   sendBeacon's text/plain body. */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const slug = String(body.slug ?? "").slice(0, 100);
  const visitorId = String(body.visitorId ?? "").slice(0, 64);
  if (!slug || !/^[a-z0-9-]+$/.test(slug) || !visitorId) return NextResponse.json({ ok: false }, { status: 400 });
  const int = (v: unknown, max = 999) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(max, Math.round(Number(v)))) : 0);
  const opens = int(body.opens);
  if (!opens) return NextResponse.json({ ok: false }, { status: 400 });
  /* The visitor's day (UTC) keys their running totals; only today or
     yesterday is taken, so a slow beacon around midnight lands right. */
  const now = Date.now();
  const days = [0, 1].map((n) => new Date(now - n * 86400_000).toISOString().slice(0, 10));
  const day = days.includes(String(body.day)) ? String(body.day) : days[0];
  const svc = createServiceClient();
  await svc
    .from("onebox_ig_views")
    .upsert(
      {
        day,
        slug,
        visitor_id: visitorId,
        engine_v: String(body.v ?? "").slice(0, 12) || null,
        opens,
        first_tile: int(body.firstTile, 99) || null,
        seen: int(body.seen, 99),
        deepest: int(body.deepest, 99),
        past6: int(body.past6, 99),
        avail: int(body.avail, 99) || null,
        swipes: int(body.swipes),
        reels: int(body.reels, 99),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "slug,visitor_id,day" }
    )
    .then(() => {});
  return NextResponse.json({ ok: true });
}
