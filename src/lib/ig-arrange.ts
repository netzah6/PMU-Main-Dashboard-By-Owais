/* The order of the funnel's in-house Instagram grid (owner, 10/26/2026,
   after the 853-picture review): finished work first — a split
   before/after, then a close-up of the result — and never a flyer or a
   selfie in the first row. Pictures are sorted by what the picture SHOWS
   (ig-classify.ts), with the caption hint as a fallback. The owner's own
   picks (pin to the front / hide) sit on top and survive every re-fetch
   because they are keyed by the post's Instagram URL, not the copied
   image. No SDK imports here: the funnel page uses this too. */

export type PostKind = "split_ba" | "after_closeup" | "during" | "person" | "flyer_text" | "other";
/* Reels (owner, 10/28/2026): `video` = our stored copy of the reel (plays when
   tapped), `img` = the best frame from INSIDE the reel (judged frame by
   frame — covers are usually text cards or selfies), `kind/pmu/q` judge
   that frame. A reel whose frames show no brows/lips/liner work is marked
   useful:false and sinks behind every picture. Until its frames are judged
   (ig-reels.ts; `useful` not set yet) a reel ranks by its cover's verdict,
   like any picture. `jt` = failed judge attempts, `cap` = the caption the
   judge reads (dropped once judged). */
export type FeedPost = { img: string; url: string; result?: boolean; kind?: PostKind; pmu?: boolean; q?: number; tries?: number; video?: string; reel?: boolean; frame?: number; useful?: boolean; jt?: number; cap?: string };
export type IgProfile = {
  username: string; name: string; pic: string; followers: number | null; posts: number | null;
  following?: number | null; bio?: string; category?: string; verified?: boolean;
};
export type IgFeed = { imgs: string[]; posts?: FeedPost[]; profile: IgProfile; at: string };

/* Seeded sets (10/15) have pictures but no post records: treat each picture
   as a post with no Instagram URL (so it can't be pinned or hidden). */
export function feedPosts(feed: IgFeed): FeedPost[] {
  return feed.posts?.length ? feed.posts : (feed.imgs ?? []).map((img) => ({ img, url: "" }));
}
export type IgPicks = { hidden?: string[]; pinned?: string[] };

export const KIND_LABEL: Record<PostKind, string> = {
  split_ba: "Before / after", after_closeup: "Result close-up", during: "In procedure",
  person: "Person / selfie", flyer_text: "Flyer / text", other: "Other",
};

/* Lower = earlier in the grid. Unsorted pictures sit between the work and
   the selfies so a feed that is not classified yet still reads sensibly. */
export function kindRank(p: FeedPost): number {
  switch (p.kind) {
    case "split_ba": return 0;
    case "after_closeup": return 1;
    case "during": return 2;
    case "other": return p.pmu && p.useful !== false ? 3 : 5;
    case "person": return 4;
    case "flyer_text": return 6;
    default: return p.result ? 2.5 : 3.5;
  }
}

/* Stable: same rank → a playable reel before a still picture (owner: video
   performs better) → better quality → the scraper's (newest-first) order.
   A reel judged not useful ranks behind everything but flyers. */
const reelRank = (p: FeedPost) => (p.video && p.useful === false ? 5.5 : kindRank(p));
export function rankPosts(posts: FeedPost[]): FeedPost[] {
  return posts
    .map((p, i) => ({ p, i }))
    .sort((a, b) => reelRank(a.p) - reelRank(b.p) || Number(!!b.p.video) - Number(!!a.p.video) || (b.p.q ?? 3) - (a.p.q ?? 3) || a.i - b.i)
    .map((x) => x.p);
}

/* What the funnel shows: the owner's pinned posts first (in pin order),
   then the ranked rest, minus hidden ones. */
export const MIN_GRID = 3;
export function arrangeFeed(feed: IgFeed, picks?: IgPicks | null): IgFeed {
  const all = feedPosts(feed);
  if (!all.length) return feed;
  const hidden = new Set(picks?.hidden ?? []);
  const pinned = picks?.pinned ?? [];
  const byUrl = new Map(all.filter((p) => p.url).map((p) => [p.url, p]));
  const front = pinned.map((u) => byUrl.get(u)).filter((p): p is FeedPost => !!p && !hidden.has(p.url));
  const rest = rankPosts(all.filter((p) => !hidden.has(p.url) && !pinned.includes(p.url)));
  let posts = [...front, ...rest];
  /* Never a blank or near-empty grid: too much hidden → automatic order. */
  if (posts.length < MIN_GRID) posts = rankPosts(all);
  return { ...feed, posts, imgs: posts.map((p) => p.img) };
}

/* The dashboard's view: the six the funnel shows, the ones waiting behind
   them, and the hidden ones — each with what it shows and the owner's mark. */
export type GridPost = FeedPost & { pinned: boolean };
export type GridView = { profile: IgProfile; at: string; shown: GridPost[]; pool: GridPost[]; hidden: GridPost[]; picks: IgPicks; classified: boolean };
export function gridView(feed: IgFeed, picks?: IgPicks | null): GridView {
  const all = feedPosts(feed);
  const urls = new Set(all.map((p) => p.url).filter(Boolean));
  /* Picks for posts that have since left the feed don't count. */
  const livePicks: IgPicks = { hidden: (picks?.hidden ?? []).filter((u) => urls.has(u)), pinned: (picks?.pinned ?? []).filter((u) => urls.has(u)) };
  const pinned = new Set(livePicks.pinned);
  const hiddenSet = new Set(livePicks.hidden);
  const arranged = (arrangeFeed(feed, livePicks).posts ?? []).map((p) => ({ ...p, pinned: pinned.has(p.url) }));
  return {
    profile: feed.profile, at: feed.at,
    shown: arranged.slice(0, 6), pool: arranged.slice(6),
    hidden: all.filter((p) => hiddenSet.has(p.url)).map((p) => ({ ...p, pinned: false })),
    picks: livePicks,
    classified: all.every((p) => !!p.kind),
  };
}
