import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { MIN_GRID, feedPosts, gridView, type IgFeed, type IgPicks } from "@/lib/ig-arrange";
import { refreshFunnel } from "@/lib/ig-fetch";

export const fetchCache = "force-no-store";
export const maxDuration = 300;

/* IG-widget controls for the CPD Funnel-setup cards (owner request
   2026-10-02):
     off / on       — hide or restore the live Elfsight feed on the funnel
                      (for widgets showing the wrong business, promos, etc.)
     freeze / unfreeze — serve the self-hosted snapshot of the posts that
                      were live when the funnel converted, so the client's
                      new IG posts stop changing the page.
   Freeze needs extras.igSnapshot (uploaded copies — Instagram CDN links
   expire, so we can't just remember URLs). The 2026-10-01 sweep seeded it
   for every live funnel; a client without one gets a clear error.
   Freeze with body.snapshotId (IG-feed watch, 2026-10-15): copy THAT dated
   ig_snapshots row — e.g. the posts that were live during the funnel's best
   run — into extras.igSnapshot first, then freeze. The row must belong to
   this slug and carry images. Only ever triggered by an explicit click.
   In-house grid picks (owner, 10/26/2026), keyed by the post's Instagram
   URL so they survive every re-fetch:
     hide / unhide  — take a picture out of the grid / put it back
     pin / unpin    — put a picture first / let the ranking place it
     reset          — forget every pick, back to the automatic order
     refresh        — fetch + sort this funnel's posts from Instagram now */

const ACTIONS = ["off", "on", "freeze", "unfreeze", "hide", "unhide", "pin", "unpin", "reset", "refresh"] as const;
type Action = (typeof ACTIONS)[number];

export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin" && auth.role !== "editor") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { slug?: string; action?: string; snapshotId?: unknown; postUrl?: unknown } | null;
  const slug = body?.slug?.trim();
  const action = body?.action as Action | undefined;
  if (!slug || !action || !ACTIONS.includes(action)) {
    return NextResponse.json({ error: `slug and action (${ACTIONS.join("|")}) required` }, { status: 400 });
  }
  const postUrl = typeof body?.postUrl === "string" ? body.postUrl.trim() : "";
  if (["hide", "unhide", "pin", "unpin"].includes(action) && !postUrl) {
    return NextResponse.json({ error: "postUrl required" }, { status: 400 });
  }
  const snapshotId = body?.snapshotId;
  if (snapshotId != null && (typeof snapshotId !== "number" || !Number.isInteger(snapshotId) || snapshotId <= 0)) {
    return NextResponse.json({ error: "snapshotId must be a whole number" }, { status: 400 });
  }

  const sb = createServiceClient();
  const { data: row, error } = await sb
    .from("onebox_clients")
    .select("slug, extras")
    .eq("slug", slug)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  let extras = { ...((row.extras ?? {}) as Record<string, unknown>) } as Record<string, unknown> & { igFeed?: IgFeed; igPicks?: IgPicks };
  if (action === "refresh") {
    const r = await refreshFunnel(sb, slug);
    if (!r.ok) return NextResponse.json({ error: `Instagram fetch failed: ${r.why}` }, { status: 502 });
    const { data: again } = await sb.from("onebox_clients").select("extras").eq("slug", slug).maybeSingle();
    extras = { ...((again?.extras ?? {}) as Record<string, unknown>) };
  }
  if (["hide", "unhide", "pin", "unpin", "reset"].includes(action)) {
    const posts = extras.igFeed ? feedPosts(extras.igFeed) : [];
    const urls = new Set(posts.map((p) => p.url).filter(Boolean));
    if (postUrl && !urls.has(postUrl)) return NextResponse.json({ error: "That picture is no longer in the feed." }, { status: 404 });
    if (extras.igFrozen && action !== "reset") return NextResponse.json({ error: "The funnel is frozen to a saved set — unfreeze it first." }, { status: 409 });
    const picks: IgPicks = { hidden: [...(extras.igPicks?.hidden ?? [])].filter((u) => urls.has(u)), pinned: [...(extras.igPicks?.pinned ?? [])].filter((u) => urls.has(u)) };
    const without = (l: string[]) => l.filter((u) => u !== postUrl);
    if (action === "hide") {
      const left = posts.filter((p) => p.url && !picks.hidden!.includes(p.url) && p.url !== postUrl).length;
      if (left < MIN_GRID) return NextResponse.json({ error: `Keep at least ${MIN_GRID} pictures on the grid — restore one first.` }, { status: 409 });
      picks.hidden = [...without(picks.hidden!), postUrl]; picks.pinned = without(picks.pinned!);
    }
    if (action === "unhide") picks.hidden = without(picks.hidden!);
    if (action === "pin") { picks.pinned = [postUrl, ...without(picks.pinned!)]; picks.hidden = without(picks.hidden!); }
    if (action === "unpin") picks.pinned = without(picks.pinned!);
    if (action === "reset") delete extras.igPicks; else extras.igPicks = picks;
  }
  if (action === "freeze") {
    if (typeof snapshotId === "number") {
      const { data: snap, error: snapErr } = await sb
        .from("ig_snapshots")
        .select("id, taken_at, imgs")
        .eq("id", snapshotId)
        .eq("slug", slug)
        .maybeSingle();
      if (snapErr) return NextResponse.json({ error: snapErr.message }, { status: 500 });
      if (!snap) {
        return NextResponse.json({ error: "That saved set of posts doesn't belong to this client." }, { status: 404 });
      }
      const imgs = (snap.imgs ?? []) as string[];
      if (!imgs.length) {
        return NextResponse.json({ error: "That saved set has no images to show." }, { status: 409 });
      }
      extras.igSnapshot = { imgs, at: snap.taken_at as string };
    } else {
      const snap = extras.igSnapshot as { imgs?: string[] } | undefined;
      if (!snap?.imgs?.length) {
        return NextResponse.json(
          { error: "No feed snapshot stored for this client yet — rerun the IG snapshot sweep first." },
          { status: 409 },
        );
      }
    }
    extras.igFrozen = true;
  }
  if (action === "unfreeze") extras.igFrozen = false;
  if (action === "off") extras.igWidgetOff = true;
  if (action === "on") extras.igWidgetOff = false;

  if (action !== "refresh") {
    /* Re-read right before writing so a fetch that finished meanwhile is kept. */
    const { data: fresh } = await sb.from("onebox_clients").select("extras").eq("slug", slug).maybeSingle();
    const merged = { ...((fresh?.extras ?? {}) as Record<string, unknown>) };
    for (const k of ["igFrozen", "igWidgetOff", "igSnapshot", "igPicks"]) { if (k in extras) merged[k] = extras[k]; else delete merged[k]; }
    const { error: upErr } = await sb.from("onebox_clients").update({ extras: merged }).eq("slug", slug);
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
    extras = merged as typeof extras;
  }

  return NextResponse.json({
    ok: true,
    slug,
    igWidgetOff: !!extras.igWidgetOff,
    igFrozen: !!extras.igFrozen,
    activeSnapshotAt: (extras.igSnapshot as { at?: string } | undefined)?.at ?? null,
    grid: extras.igFeed?.imgs?.length ? gridView(extras.igFeed, extras.igPicks) : null,
  });
}
