import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { reviewFunnelConfig, FLEET } from "@/lib/funnel-checks";
import { arrangeFeed, feedPosts, type IgFeed, type IgPicks } from "@/lib/ig-arrange";

export const fetchCache = "force-no-store";

/* Funnel-setup review for the Cost/Deposit ✨ AI Recommendation box.
   The checks themselves live in src/lib/funnel-checks.ts (shared with the
   client brief, src/lib/cpd-brief.ts). */

const PAID = ["booked", "paid", "paid-not-booked", "paid-followup"];

export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const locationId = req.nextUrl.searchParams.get("locationId")?.trim();
  if (!locationId) return NextResponse.json({ error: "locationId required" }, { status: 400 });

  const sb = createServiceClient();
  const { data: client, error } = await sb
    .from("onebox_clients")
    .select("slug, client_name, status, config, extras, created_at")
    .eq("location_id", locationId)
    .eq("status", "live")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!client) return NextResponse.json({ found: false });

  const cfg = (client.config ?? {}) as Record<string, string>;

  // Last-30-day funnel numbers for this slug (counts only — cheap).
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const since = cutoff.toISOString();
  const count = async (kind: "leads" | "picked" | "paid") => {
    let q = sb
      .from("onebox_leads")
      .select("id", { count: "exact", head: true })
      .eq("slug", client.slug)
      .gte("created_at", since);
    if (kind === "picked") q = q.or(`picked_time_at.not.is.null,ghl_status.in.(${PAID.join(",")})`);
    if (kind === "paid") q = q.in("ghl_status", PAID);
    const { count: n } = await q;
    return n ?? 0;
  };
  const [leads, picked, paid] = await Promise.all([count("leads"), count("picked"), count("paid")]);

  const ageDays = client.created_at
    ? Math.floor((Date.now() - new Date(client.created_at).getTime()) / 86_400_000)
    : null;

  const extras = (client.extras ?? {}) as Record<string, unknown>;
  const feed = extras.igFeed as IgFeed | undefined;
  const gridTiles = feed ? feedPosts(arrangeFeed(feed, extras.igPicks as IgPicks | undefined)).length : 0;
  const hasIgFeed = gridTiles >= 3 && !extras.igWidgetOff;
  const { checks, config } = reviewFunnelConfig({ cfg, extras, ageDays, hasIgFeed });

  const ex = (client.extras ?? {}) as { igWidgetOff?: boolean; igFrozen?: boolean; igSnapshot?: { imgs?: string[] } };
  return NextResponse.json({
    found: true,
    slug: client.slug,
    name: client.client_name,
    // IG-widget controls state for the card's Off/Freeze buttons.
    igState: {
      hasWidget: config.igWidget,
      widgetOff: !!ex.igWidgetOff,
      frozen: !!ex.igFrozen,
      hasSnapshot: !!ex.igSnapshot?.imgs?.length,
    },
    ageDays,
    stats: {
      leads30: leads,
      picked30: picked,
      paid30: paid,
      leadToPicked: leads ? Math.round((picked / leads) * 100) : null,
      pickedToPaid: picked ? +((paid / picked) * 100).toFixed(1) : null,
      fleet: FLEET,
    },
    config,
    checks,
  });
}
