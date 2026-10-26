import type { SupabaseClient } from "@supabase/supabase-js";

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
const POSTS_PER_PROFILE = 6;
const MAX_POSTS = 12;
const DOWNLOAD_TIMEOUT_MS = 20_000;
/* The Apify run gets 2 minutes; the daily cron has 5 in total and still
   has to copy the images after the run comes back. */
const APIFY_RUN_TIMEOUT_S = 120;
/* Agency-owned demo funnels — no client Instagram behind them. */
const SKIP_SLUGS = new Set(["demo-v3", "pmu-bookings"]);

export type IgProfile = {
  username: string; name: string; pic: string; followers: number | null; posts: number | null;
  following?: number | null; bio?: string; category?: string; verified?: boolean;
};
export type IgFeed = { imgs: string[]; posts: Array<{ img: string; url: string }>; profile: IgProfile; at: string };
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

/* The scraper sends "None" / "null" as text for empty fields. */
function cleanText(v: unknown): string {
  const t = typeof v === "string" ? v.trim() : "";
  return /^(none|null|undefined)$/i.test(t) ? "" : t;
}

export async function markFetch(svc: SupabaseClient, slug: string, ok: boolean, why?: string) {
  const { data: row } = await svc.from("onebox_clients").select("extras").eq("slug", slug).maybeSingle();
  const mark: IgFetchMark = { at: new Date().toISOString(), ok, ...(why ? { why } : {}) };
  const extras = { ...((row?.extras ?? {}) as Record<string, unknown>), igFetch: mark };
  await svc.from("onebox_clients").update({ extras }).eq("slug", slug);
}

export type ApifyPost = {
  type?: string; url?: string; displayUrl?: string; thumbnailUrl?: string; images?: string[]; childPosts?: ApifyPost[]; timestamp?: string;
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
): Promise<{ ok: true; imgs: number } | { ok: false; why: string }> {
  const posts = latest.filter((p) => postImage(p)).slice(0, MAX_POSTS);
  if (posts.length < 3) return { ok: false, why: `only ${posts.length} posts returned` };
  const { data: row } = await svc.from("onebox_clients").select("extras").eq("slug", slug).maybeSingle();
  const prevExtras = (row?.extras ?? {}) as Record<string, unknown> & { igFeed?: IgFeed };
  const prev = prevExtras.igFeed?.profile;
  const today = new Date().toISOString().slice(0, 10);
  /* Copy every image at once (≤ 13 small files) — one by one would eat
     the cron's time budget. */
  const copy = async (src: string, path: string): Promise<string> => {
    const body = await download(src);
    if (!body) return "";
    const { error } = await svc.storage.from(BUCKET).upload(path, body, { upsert: true, contentType: "image/jpeg" });
    return error ? "" : svc.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  };
  const [newPic, ...copies] = await Promise.all([
    copy(prof?.profilePicUrlHD || prof?.profilePicUrl || "", `${slug}/${today}/profile.jpg`),
    ...posts.map((p, n) => copy(postImage(p), `${slug}/${today}/${n + 1}.jpg`)),
  ]);
  const saved = copies.map((img, n) => ({ img, url: posts[n].url || igLink })).filter((p) => p.img);
  if (saved.length < 3) return { ok: false, why: `only ${saved.length} images downloaded` };
  /* The profile scraper stopped returning the post count (10/2026); the
     weekly Playwright snapshot still records it, so fall back to the newest
     one we have. */
  let postsCount: number | null = typeof prof?.postsCount === "number" ? prof.postsCount : prev?.posts ?? null;
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
  const feed: IgFeed = { imgs: saved.map((p) => p.img), posts: saved, profile, at: today };
  await svc.from("ig_snapshots").delete().eq("slug", slug).eq("taken_at", today);
  const { error: insErr } = await svc.from("ig_snapshots").insert({
    slug, taken_at: today, imgs: feed.imgs, posts_count: profile.posts, followers: profile.followers, source: "apify", profile, posts: saved,
  });
  if (insErr) return { ok: false, why: `insert: ${insErr.message}` };
  const mark: IgFetchMark = { at: new Date().toISOString(), ok: true };
  const extras = { ...prevExtras, igFeed: feed, igFetch: mark };
  const { error: upErr } = await svc.from("onebox_clients").update({ extras }).eq("slug", slug);
  if (upErr) return { ok: false, why: `extras: ${upErr.message}` };
  return { ok: true, imgs: saved.length };
}

/* Funnels due for a fresh set: live, with a real Instagram handle, and not
   tried in the last `minAgeDays` (extras.igFetch, written by this fetcher
   only — the Mac Mini's weekly ig_snapshots rows don't count). Never-tried
   first, then the longest ago. */
export async function dueFunnels(svc: SupabaseClient, limit: number, minAgeDays = 6): Promise<Array<{ slug: string; igLink: string; username: string }>> {
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
