import type { SupabaseClient } from "@supabase/supabase-js";
import { queueIgPostsCheck } from "@/lib/ig-posts-check";
import { classifyImages } from "@/lib/ig-classify";
import { feedPosts, rankPosts, type FeedPost, type IgFeed, type IgProfile } from "@/lib/ig-arrange";
import { MAX_REEL_SECONDS, postCode, storeReelVideo } from "@/lib/ig-reels";
export type { FeedPost, IgFeed, IgProfile } from "@/lib/ig-arrange";

/* In-house Instagram feed (owner, 10/26/2026): replaces the Elfsight widget
   on the funnels. Nothing is asked of the client — from the Instagram
   username alone, a scraping service (Apify's public-profile scraper)
   returns the profile and the latest posts, we copy the images into our
   own Storage bucket, and the funnel renders them as a 3 × 2 grid with a
   profile header. The copies live in ig_snapshots (one row per funnel per
   day) and the latest set is mirrored into onebox_clients.extras.igFeed,
   which the funnel page reads with no extra query. A fetch that fails
   leaves the previous set in place, so a funnel never goes blank. */

const BUCKET = "onebox-ig";
/* Two scrapers: the profile one gives name / picture / followers (it stopped
   returning posts in 10/2026), the post one gives the latest posts. Both are
   billed per result (~$2.70 / 1,000 on the Free plan), so we take only what
   the 3 × 2 grid shows. */
const PROFILE_ACTOR = "apify~instagram-profile-scraper";
const POST_ACTOR = "apify~instagram-post-scraper";
/* Pull 12, show 6: results posts (before/after, brows, lips, liner…) go
   first, newest first; the rest fill in behind them. Refreshed every two
   weeks — that keeps the whole fleet inside Apify's free credit. */
const POSTS_PER_PROFILE = 12;
const MAX_POSTS = 12;
const REFRESH_DAYS = 13;
const RESULTS_RE = /\b(before|after|brow|brows|eyebrow|lip|lips|liner|eyeliner|lash ?line|heal|healed|healing|microblad|ombre|ombré|powder|nano|hairstroke|hair stroke|combo|permanent makeup|pmu|touch ?up|transformation|result|results|fresh|freshly|done|correction|cover ?up|areola|scalp|smp|beauty mark|freckles)\b/i;
const DOWNLOAD_TIMEOUT_MS = 20_000;
/* The Apify run gets 2 minutes; the daily cron has 5 in total and still
   has to copy the images after the run comes back. */
const APIFY_RUN_TIMEOUT_S = 120;
/* Agency-owned demo funnels — no client Instagram behind them. */
const SKIP_SLUGS = new Set(["demo-v3", "pmu-bookings"]);


/* Results posts first (caption says before/after, brows, lips…), then the
   rest; newest first within each group; a picture beats a video when the
   caption says nothing. */
export function isResultPost(p: ApifyPost): boolean {
  return RESULTS_RE.test(String(p.caption ?? ""));
}
export function orderPosts(latest: ApifyPost[]): ApifyPost[] {
  const ts = (p: ApifyPost) => Date.parse(p.timestamp ?? "") || 0;
  const rank = (p: ApifyPost) => (isResultPost(p) ? 0 : p.type === "Video" ? 2 : 1);
  return [...latest].sort((a, b) => rank(a) - rank(b) || ts(b) - ts(a));
}
/* Last fetch attempt, success or not — the due list is ordered by it so a
   funnel that keeps failing never blocks the others. */
export type IgFetchMark = { at: string; ok: boolean; why?: string };

/* "https://www.instagram.com/blossom.pmu/" or "@blossom.pmu" → "blossom.pmu".
   Anything else (a form link, "Instagram Page Link.", a Facebook URL) → ""
   so it is never sent to the scraper. */
export function usernameFromLink(link: string | null | undefined): string {
  const s = String(link ?? "").trim();
  if (!s) return "";
  const m = s.match(/instagram\.com\/([A-Za-z0-9._]{1,30})(?:[/?#]|$)/i);
  const u = m ? m[1] : /^@?[A-Za-z0-9._]{1,30}$/.test(s) ? s.replace(/^@/, "") : "";
  return /^(p|reel|reels|explore|accounts|stories)$/i.test(u) ? "" : u;
}

/* Post count from Elfsight's public Instagram profile endpoint (keyed by
   username, no widget needed) — the same call ig-feed-watch makes. */
export async function elfsightPostsCount(username: string): Promise<number | null> {
  if (!username) return null;
  try {
    const r = await fetch(`https://widget-data.service.elfsight.com/api/instagram/profile?username=${encodeURIComponent(username)}`, { signal: AbortSignal.timeout(10_000) });
    const d = ((await r.json()) as { payload?: { postsCount?: unknown } }).payload;
    return typeof d?.postsCount === "number" ? d.postsCount : null;
  } catch { return null; }
}

/* The scraper sends "None" / "null" as text for empty fields. */
function cleanText(v: unknown): string {
  const t = typeof v === "string" ? v.trim() : "";
  return /^(none|null|undefined)$/i.test(t) ? "" : t;
}

/* Write only the keys we own: re-read extras right before the update so a
   pick the owner saved during a slow fetch/classify is not overwritten. */
export async function patchExtras(svc: SupabaseClient, slug: string, patch: Record<string, unknown>): Promise<string | null> {
  const { data: row } = await svc.from("onebox_clients").select("extras").eq("slug", slug).maybeSingle();
  const extras = { ...((row?.extras ?? {}) as Record<string, unknown>), ...patch };
  const { error } = await svc.from("onebox_clients").update({ extras }).eq("slug", slug);
  return error ? error.message : null;
}

export async function markFetch(svc: SupabaseClient, slug: string, ok: boolean, why?: string) {
  const mark: IgFetchMark = { at: new Date().toISOString(), ok, ...(why ? { why } : {}) };
  await patchExtras(svc, slug, { igFetch: mark });
}

export type ApifyPost = {
  type?: string; url?: string; displayUrl?: string; thumbnailUrl?: string; images?: string[]; childPosts?: ApifyPost[]; timestamp?: string; caption?: string;
  videoUrl?: string; videoDuration?: number;
  ownerUsername?: string; ownerFullName?: string; inputUrl?: string; error?: string; errorDescription?: string;
};

/* The image to show for a post: its own picture, else the first slide of a
   carousel, else the video thumbnail. */
export function postImage(p: ApifyPost): string {
  return p.displayUrl || p.images?.[0] || p.thumbnailUrl || p.childPosts?.[0]?.displayUrl || p.childPosts?.[0]?.images?.[0] || "";
}
export type ApifyProfile = {
  username?: string; fullName?: string; followersCount?: number; followsCount?: number; postsCount?: number; private?: boolean;
  biography?: string; businessCategoryName?: string; verified?: boolean;
  profilePicUrlHD?: string; profilePicUrl?: string; latestPosts?: ApifyPost[]; error?: string; errorDescription?: string;
};

/* One synchronous Apify run; returns the dataset items. */
async function runActor<T>(actor: string, input: Record<string, unknown>): Promise<T[]> {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error("no APIFY_TOKEN");
  const r = await fetch(`https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&timeout=${APIFY_RUN_TIMEOUT_S}&memory=1024&format=json`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout((APIFY_RUN_TIMEOUT_S + 20) * 1000),
  });
  if (!r.ok) throw new Error(`apify ${actor} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const items = (await r.json()) as T[];
  return Array.isArray(items) ? items : [];
}

/* Profile details for a batch of usernames → map username(lower) → profile. */
export async function fetchProfiles(usernames: string[]): Promise<Map<string, ApifyProfile>> {
  const out = new Map<string, ApifyProfile>();
  for (const it of await runActor<ApifyProfile>(PROFILE_ACTOR, { usernames })) if (it?.username) out.set(it.username.toLowerCase(), it);
  return out;
}

/* Probe: the general Instagram scraper's "details" mode for the same
   profiles (does it still return postsCount?). Debug only for now. */
export async function fetchDetails(usernames: string[]): Promise<Map<string, ApifyProfile>> {
  const out = new Map<string, ApifyProfile>();
  const items = await runActor<ApifyProfile & { inputUrl?: string }>("apify~instagram-scraper", {
    directUrls: usernames.map((u) => `https://www.instagram.com/${u}/`), resultsType: "details", resultsLimit: 1, addParentData: false,
  });
  for (const it of items) if (it?.username) out.set(it.username.toLowerCase(), it);
  return out;
}

/* Latest posts for a batch of usernames → map username(lower) → posts
   (newest first, as the scraper returns them). */
export async function fetchPosts(usernames: string[]): Promise<Map<string, ApifyPost[]>> {
  const out = new Map<string, ApifyPost[]>();
  for (const it of await runActor<ApifyPost>(POST_ACTOR, { username: usernames, resultsLimit: POSTS_PER_PROFILE })) {
    const u = (it?.ownerUsername ?? usernameFromLink(it?.inputUrl)).toLowerCase();
    if (!u || !postImage(it)) continue;
    out.set(u, [...(out.get(u) ?? []), it]);
  }
  return out;
}

async function download(url: string): Promise<Buffer | null> {
  try {
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15" }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!r.ok || !/^image\//.test(r.headers.get("content-type") ?? "")) return null;
    const b = Buffer.from(await r.arrayBuffer());
    return b.length > 1000 ? b : null;
  } catch { return null; }
}

/* Snapshot one funnel from already-fetched posts (+ profile details when
   the profile scraper returned them; otherwise the previous set's details
   stay): copy the images, write the ig_snapshots row for today (replace),
   mirror into extras. */
export async function snapshotFunnel(
  svc: SupabaseClient, slug: string, prof: ApifyProfile | undefined, latest: ApifyPost[], igLink: string,
): Promise<{ ok: true; imgs: number; results: number } | { ok: false; why: string }> {
  const posts = orderPosts(latest.filter((p) => postImage(p))).slice(0, MAX_POSTS);
  if (posts.length < 3) return { ok: false, why: `only ${posts.length} posts returned` };
  const { data: row } = await svc.from("onebox_clients").select("extras").eq("slug", slug).maybeSingle();
  const prevExtras = (row?.extras ?? {}) as Record<string, unknown> & { igFeed?: IgFeed };
  const prev = prevExtras.igFeed?.profile;
  const today = new Date().toISOString().slice(0, 10);
  /* Verdicts from the previous set carry over by post URL (below); a reel
     already copied keeps its stored video, so it isn't downloaded again. */
  const known = new Map((prevExtras.igFeed?.posts ?? []).filter((p) => (p.kind || p.video) && p.url).map((p) => [p.url, p]));
  /* Copy every image at once (≤ 13 small files) — one by one would eat
     the cron's time budget. */
  const copy = async (src: string, path: string): Promise<string> => {
    const body = await download(src);
    if (!body) return "";
    const { error } = await svc.storage.from(BUCKET).upload(path, body, { upsert: true, contentType: "image/jpeg" });
    return error ? "" : svc.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  };
  /* Reels (owner 10/28/2026): the video is copied now — Instagram's video
     links expire — and judged frame by frame later (ig-reels.ts, its own
     cron); until then the reel shows its cover like any picture. */
  const reelCopy = (p: ApifyPost): Promise<string> => {
    const code = postCode(p.url);
    if (!p.videoUrl || !code || known.get(p.url ?? "")?.video || (p.videoDuration ?? 0) > MAX_REEL_SECONDS) return Promise.resolve("");
    return storeReelVideo(svc, slug, code, p.videoUrl);
  };
  const [[newPic, ...copies], videos] = await Promise.all([
    Promise.all([
      copy(prof?.profilePicUrlHD || prof?.profilePicUrl || "", `${slug}/${today}/profile.jpg`),
      ...posts.map((p, n) => copy(postImage(p), `${slug}/${today}/${n + 1}.jpg`)),
    ]),
    Promise.all(posts.map(reelCopy)),
  ]);
  const saved: FeedPost[] = copies
    .map((img, n): FeedPost => ({
      img, url: posts[n].url || igLink, result: isResultPost(posts[n]),
      ...(videos[n] ? { video: videos[n], reel: true, cap: String(posts[n].caption ?? "").slice(0, 400) } : {}),
    }))
    .filter((p) => p.img);
  if (saved.length < 3) return { ok: false, why: `only ${saved.length} images downloaded` };
  /* The new pictures are looked at AFTER the set is saved (below), so a
     slow or failed classification never throws the paid fetch away. */
  for (const p of saved) {
    const c = known.get(p.url);
    if (!c) continue;
    if (c.kind) { p.kind = c.kind; p.pmu = c.pmu; p.q = c.q; }
    /* A reel keeps its stored video and, once judged, the frame chosen from
       inside it — the fresh copy is only its cover. Not judged yet: it
       keeps its place in the judge's queue (attempts + caption). */
    if (c.video) {
      p.video = c.video; p.reel = true;
      if (c.useful !== undefined) { p.img = c.img; p.frame = c.frame; p.useful = c.useful; delete p.cap; }
      else { if (c.jt) p.jt = c.jt; p.cap = c.cap ?? p.cap; }
    }
  }
  const ordered = rankPosts(saved);
  /* The scrapers stopped returning the post count (10/2026). Elfsight's
     public profile endpoint still has it (live), then the previous set,
     then the newest Playwright snapshot. */
  let postsCount: number | null = typeof prof?.postsCount === "number" ? prof.postsCount : null;
  if (postsCount == null) postsCount = await elfsightPostsCount(prof?.username || posts[0].ownerUsername || usernameFromLink(igLink));
  if (postsCount == null) postsCount = prev?.posts ?? null;
  if (postsCount == null) {
    const { data: snap } = await svc.from("ig_snapshots").select("posts_count").eq("slug", slug).not("posts_count", "is", null).order("taken_at", { ascending: false }).limit(1).maybeSingle();
    if (typeof snap?.posts_count === "number") postsCount = snap.posts_count;
  }
  const profile: IgProfile = {
    username: prof?.username || posts[0].ownerUsername || usernameFromLink(igLink),
    name: prof?.fullName || posts[0].ownerFullName || prev?.name || "",
    pic: newPic || prev?.pic || "",
    followers: typeof prof?.followersCount === "number" ? prof.followersCount : prev?.followers ?? null,
    posts: postsCount,
    following: typeof prof?.followsCount === "number" ? prof.followsCount : prev?.following ?? null,
    bio: (cleanText(prof?.biography) || prev?.bio || "").slice(0, 300),
    category: cleanText(prof?.businessCategoryName) || prev?.category || "",
    verified: !!(prof?.verified ?? prev?.verified),
  };
  const feed: IgFeed = { imgs: ordered.map((p) => p.img), posts: ordered, profile, at: today };
  await svc.from("ig_snapshots").delete().eq("slug", slug).eq("taken_at", today);
  const { error: insErr } = await svc.from("ig_snapshots").insert({
    slug, taken_at: today, imgs: feed.imgs, posts_count: profile.posts, followers: profile.followers, source: "apify", profile, posts: ordered,
  });
  if (insErr) return { ok: false, why: `insert: ${insErr.message}` };
  const mark: IgFetchMark = { at: new Date().toISOString(), ok: true };
  const upErr = await patchExtras(svc, slug, { igFeed: feed, igFetch: mark });
  /* Still no post count from any source: the Mac Mini reads it off the
     public profile page (owner 10/27/2026: a header without "posts" looks
     fake). One card per funnel; the answer sticks via prev.posts. */
  if (postsCount == null && profile.username) {
    try { await queueIgPostsCheck(svc, { slug, username: profile.username, by: "ig-fetch" }); } catch { /* next run tries again */ }
  }
  if (upErr) return { ok: false, why: `extras: ${upErr}` };
  /* Now look at the new pictures and re-rank (second, separate write). */
  const todo = ordered.filter((p) => !p.kind);
  if (todo.length) {
    const cls = await classifyImages(todo.map((p) => p.img));
    if (cls.size) {
      for (const p of ordered) { const c = cls.get(p.img); if (c) { p.kind = c.kind; p.pmu = c.pmu; p.q = c.q; } }
      const re = rankPosts(ordered);
      await patchExtras(svc, slug, { igFeed: { ...feed, posts: re, imgs: re.map((p) => p.img) } });
    }
  }
  return { ok: true, imgs: saved.length, results: saved.filter((p) => p.result).length };
}

/* Funnels due for a fresh set: live, with a real Instagram handle, and not
   tried in the last `minAgeDays` (extras.igFetch, written by this fetcher
   only — the Mac Mini's weekly ig_snapshots rows don't count). Never-tried
   first, then the longest ago. */
export async function dueFunnels(svc: SupabaseClient, limit: number, minAgeDays = REFRESH_DAYS): Promise<Array<{ slug: string; igLink: string; username: string }>> {
  const { data: clients } = await svc.from("onebox_clients").select("slug, config, extras").eq("status", "live");
  const cutoff = new Date(Date.now() - minAgeDays * 86400_000).toISOString();
  return (clients ?? [])
    .map((c) => {
      const cfg = (c.config ?? {}) as Record<string, string>;
      const ex = (c.extras ?? {}) as { template?: string; igWidgetOff?: boolean; igFetch?: IgFetchMark };
      const igLink = String(cfg.igLink ?? "").trim();
      return { slug: String(c.slug), igLink, username: usernameFromLink(igLink), b2b: ex.template === "b2b", off: !!ex.igWidgetOff, last: ex.igFetch?.at ?? "" };
    })
    .filter((c) => c.username && !c.b2b && !c.off && !SKIP_SLUGS.has(c.slug) && c.last < cutoff)
    .sort((a, b) => a.last.localeCompare(b.last))
    .slice(0, limit)
    .map(({ slug, igLink, username }) => ({ slug, igLink, username }));
}

/* Fetch + classify one funnel right now (the dashboard's "Refresh from
   Instagram" button). Marks the attempt like the cron does. */
export async function refreshFunnel(svc: SupabaseClient, slug: string): Promise<{ ok: true; imgs: number; results: number } | { ok: false; why: string }> {
  const { data: row } = await svc.from("onebox_clients").select("slug, config").eq("slug", slug).maybeSingle();
  const igLink = String((row?.config as Record<string, string> | null)?.igLink ?? "").trim();
  const username = usernameFromLink(igLink);
  if (!username) return { ok: false, why: "no Instagram handle on this funnel" };
  let prof: ApifyProfile | undefined;
  let posts: ApifyPost[] = [];
  try {
    const [profiles, byUser] = await Promise.all([
      fetchProfiles([username]).catch(() => new Map<string, ApifyProfile>()),
      fetchPosts([username]),
    ]);
    prof = profiles.get(username.toLowerCase());
    posts = byUser.get(username.toLowerCase()) ?? [];
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
  if (!posts.length) {
    const why = prof?.private ? "private account" : "no posts returned (private, renamed, or blocked)";
    await markFetch(svc, slug, false, why);
    return { ok: false, why };
  }
  const r = await snapshotFunnel(svc, slug, prof, posts, igLink);
  if (!r.ok) await markFetch(svc, slug, false, r.why);
  return r;
}

/* Classify the pictures a funnel already has (no Apify call) and re-rank
   them. Used to backfill the fleet and by the cron's spare time. Returns
   how many pictures were looked at. */
const CLASSIFY_TRIES = 3;
const needsLook = (p: FeedPost) => !p.kind && (p.tries ?? 0) < CLASSIFY_TRIES;

export async function classifyStoredFeed(svc: SupabaseClient, slug: string, errors: string[] = []): Promise<number> {
  const { data: row } = await svc.from("onebox_clients").select("extras").eq("slug", slug).maybeSingle();
  const extras = (row?.extras ?? {}) as Record<string, unknown> & { igFeed?: IgFeed };
  const feed = extras.igFeed;
  if (!feed?.posts?.length) return 0;
  const todo = feed.posts.filter(needsLook);
  if (!todo.length) return 0;
  const cls = await classifyImages(todo.map((p) => p.img), errors);
  for (const p of todo) {
    const c = cls.get(p.img);
    if (c) { p.kind = c.kind; p.pmu = c.pmu; p.q = c.q; delete p.tries; }
    else p.tries = (p.tries ?? 0) + 1; // a picture that keeps failing stops being retried after CLASSIFY_TRIES
  }
  const ordered = rankPosts(feed.posts!);
  await patchExtras(svc, slug, { igFeed: { ...feed, posts: ordered, imgs: ordered.map((p) => p.img) } });
  return cls.size;
}

/* Live funnels whose grid still has pictures to look at — the ones with
   the most unsorted pictures first, so a whole fleet gets its first pass
   before any funnel gets its stragglers. */
export async function unclassifiedFunnels(svc: SupabaseClient, limit: number): Promise<string[]> {
  const { data: clients } = await svc.from("onebox_clients").select("slug, extras").eq("status", "live");
  return (clients ?? [])
    .map((c) => { const f = (c.extras as { igFeed?: IgFeed } | null)?.igFeed; return { slug: String(c.slug), n: f?.posts?.length ? feedPosts(f).filter(needsLook).length : 0 }; })
    .filter((c) => c.n > 0)
    .sort((a, b) => b.n - a.n || a.slug.localeCompare(b.slug))
    .slice(0, limit)
    .map((c) => c.slug);
}
