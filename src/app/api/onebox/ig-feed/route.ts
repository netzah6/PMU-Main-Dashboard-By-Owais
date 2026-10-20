import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { bestWindow, currentWindow, dropSignal, elfsightProfile, weeklySeries } from "@/lib/ig-feed-watch";

export const fetchCache = "force-no-store";

/* Instagram-feed watch for one funnel (owner, 2026-10-15) — feeds the
   "📈 Posts vs deposit rate" panel on the CPD Funnel-setup card:
     series    — 12 weekly points (leads / picked / deposits), oldest first,
                 the in-progress week last
     best      — the funnel's best 4-week window (mature weeks, ≥30 leads)
     current   — the last 2 MATURE weeks
     drop      — dropped / recovered verdict (see src/lib/ig-feed-watch.ts)
     snapshots — dated, self-hosted copies of the posts (newest first)
     history   — the feed's post count per week (ig_feed_history)
     live      — Elfsight's public profile numbers right now (null-safe)
   bestSnapshotId is ONLY a set saved on or before the best window's last
   Sunday — a set saved after the run is not "the best-run posts", so there
   is deliberately no fallback to the oldest snapshot. Nothing here changes
   the funnel; the freeze itself is an explicit click on /api/onebox/ig-widget. */

type SnapshotRow = { id: number; taken_at: string; imgs: string[] | null; posts_count: number | null; source: string | null };
type HistoryRow = { week_start: string; posts_count: number | null; followers: number | null; captured_at: string | null };

export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin" && auth.role !== "editor") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const slug = req.nextUrl.searchParams.get("slug")?.trim();
  if (!slug) return NextResponse.json({ error: "slug required" }, { status: 400 });

  const sb = createServiceClient();
  const { data: client, error } = await sb
    .from("onebox_clients")
    .select("slug, config, extras")
    .eq("slug", slug)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const cfg = (client.config ?? {}) as Record<string, unknown>;
  const extras = (client.extras ?? {}) as { igFrozen?: boolean; igSnapshot?: { imgs?: string[]; at?: string }; elfsightId?: string };
  // Same lookup order as the funnel engine (src/app/f/[slug]/route.ts).
  const widget = String(cfg.igWidget ?? cfg.elfsightId ?? extras.elfsightId ?? "").trim();
  const hasWidget = !!widget;

  const series = await weeklySeries(sb, slug, 12);
  const since = series[0]?.week ?? new Date().toISOString().slice(0, 10);

  const [snapRes, histRes, live] = await Promise.all([
    sb
      .from("ig_snapshots")
      .select("id, taken_at, imgs, posts_count, source")
      .eq("slug", slug)
      .order("taken_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(12),
    sb
      .from("ig_feed_history")
      .select("week_start, posts_count, followers, captured_at")
      .eq("slug", slug)
      .gte("week_start", since)
      .order("week_start", { ascending: true })
      .limit(12),
    // Never let a flaky Elfsight call fail the whole panel.
    hasWidget ? elfsightProfile(widget).catch(() => null) : Promise.resolve(null),
  ]);
  if (snapRes.error) return NextResponse.json({ error: snapRes.error.message }, { status: 500 });
  if (histRes.error) return NextResponse.json({ error: histRes.error.message }, { status: 500 });

  const snapshots = ((snapRes.data ?? []) as SnapshotRow[]).map((s) => ({
    id: s.id,
    taken_at: s.taken_at,
    imgs: s.imgs ?? [],
    posts_count: s.posts_count,
    source: s.source,
  }));
  const history = (histRes.data ?? []) as HistoryRow[];

  const best = bestWindow(series);
  const current = currentWindow(series);
  const drop = dropSignal(best, current);

  // best.to is the window's last Monday; +6 days = its Sunday. Snapshots are
  // newest-first, so the first one at or before that Sunday is the newest.
  let bestSnapshotId: number | null = null;
  if (best) {
    const lastSunday = new Date(Date.parse(best.to) + 6 * 864e5).toISOString().slice(0, 10);
    bestSnapshotId = snapshots.find((s) => s.taken_at <= lastSunday)?.id ?? null;
  }
  const latestSnapshotId = snapshots[0]?.id ?? null;

  return NextResponse.json({
    series,
    best,
    current,
    drop,
    snapshots,
    history,
    live,
    frozen: !!extras.igFrozen,
    activeSnapshotAt: extras.igSnapshot?.at ?? null,
    hasWidget,
    bestSnapshotId,
    latestSnapshotId,
  });
}
