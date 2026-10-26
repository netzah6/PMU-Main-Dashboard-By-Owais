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
const ACTOR = "apify~instagram-profile-scraper";
const MAX_POSTS = 12;
const DOWNLOAD_TIMEOUT_MS = 20_000;

export type IgProfile = { username: string; name: string; pic: string; followers: number | null; posts: number | null };
export type IgFeed = { imgs: string[]; posts: Array<{ img: string; url: string }>; profile: IgProfile; at: string };

export function usernameFromLink(link: string | null | undefined): string {
  const s = String(link ?? "").trim();
  if (!s) return "";
  const m = s.match(/instagram\.com\/([A-Za-z0-9._]+)/i);
  const u = (m ? m[1] : s.replace(/^@/, "")).replace(/[^A-Za-z0-9._]/g, "");
  return /^(p|reel|explore|accounts)$/i.test(u) ? "" : u;
}

type ApifyPost = { type?: string; url?: string; displayUrl?: string; images?: string[]; timestamp?: string };
type ApifyProfile = {
  username?: string; fullName?: string; followersCount?: number; postsCount?: number;
  profilePicUrlHD?: string; profilePicUrl?: string; latestPosts?: ApifyPost[]; error?: string; errorDescription?: string;
};

/* One Apify run for a batch of usernames (sync; the actor is quick for
   public profiles). Returns a map username(lower) → profile. */
export async function fetchProfiles(usernames: string[]): Promise<Map<string, ApifyProfile>> {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error("no APIFY_TOKEN");
  const r = await fetch(`https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&timeout=240&memory=512&format=json`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usernames, resultsLimit: MAX_POSTS }),
    signal: AbortSignal.timeout(280_000),
  });
  if (!r.ok) throw new Error(`apify ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const items = (await r.json()) as ApifyProfile[];
  const out = new Map<string, ApifyProfile>();
  for (const it of Array.isArray(items) ? items : []) if (it?.username) out.set(it.username.toLowerCase(), it);
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

/* Snapshot one funnel from an already-fetched profile: copy the images,
   write the ig_snapshots row for today (replace), mirror into extras. */
export async function snapshotFunnel(
  svc: SupabaseClient, slug: string, prof: ApifyProfile, igLink: string,
): Promise<{ ok: true; imgs: number } | { ok: false; why: string }> {
  const posts = (prof.latestPosts ?? []).filter((p) => p.displayUrl || p.images?.[0]).slice(0, MAX_POSTS);
  if (posts.length < 3) return { ok: false, why: `only ${posts.length} posts returned` };
  const today = new Date().toISOString().slice(0, 10);
  const saved: Array<{ img: string; url: string }> = [];
  for (let n = 0; n < posts.length; n++) {
    const src = posts[n].displayUrl || posts[n].images?.[0] || "";
    const body = await download(src);
    if (!body) continue;
    const path = `${slug}/${today}/${saved.length + 1}.jpg`;
    const { error } = await svc.storage.from(BUCKET).upload(path, body, { upsert: true, contentType: "image/jpeg" });
    if (error) continue;
    saved.push({ img: svc.storage.from(BUCKET).getPublicUrl(path).data.publicUrl, url: posts[n].url || igLink });
  }
  if (saved.length < 3) return { ok: false, why: `only ${saved.length} images downloaded` };
  let pic = "";
  const picBody = await download(prof.profilePicUrlHD || prof.profilePicUrl || "");
  if (picBody) {
    const path = `${slug}/${today}/profile.jpg`;
    const { error } = await svc.storage.from(BUCKET).upload(path, picBody, { upsert: true, contentType: "image/jpeg" });
    if (!error) pic = svc.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  }
  const profile: IgProfile = {
    username: prof.username ?? usernameFromLink(igLink), name: prof.fullName ?? "", pic,
    followers: typeof prof.followersCount === "number" ? prof.followersCount : null,
    posts: typeof prof.postsCount === "number" ? prof.postsCount : null,
  };
  const feed: IgFeed = { imgs: saved.map((p) => p.img), posts: saved, profile, at: today };
  await svc.from("ig_snapshots").delete().eq("slug", slug).eq("taken_at", today);
  const { error: insErr } = await svc.from("ig_snapshots").insert({
    slug, taken_at: today, imgs: feed.imgs, posts_count: profile.posts, followers: profile.followers, source: "apify", profile, posts: saved,
  });
  if (insErr) return { ok: false, why: `insert: ${insErr.message}` };
  const { data: row } = await svc.from("onebox_clients").select("extras").eq("slug", slug).maybeSingle();
  const extras = { ...((row?.extras ?? {}) as Record<string, unknown>), igFeed: feed };
  const { error: upErr } = await svc.from("onebox_clients").update({ extras }).eq("slug", slug);
  if (upErr) return { ok: false, why: `extras: ${upErr.message}` };
  return { ok: true, imgs: saved.length };
}

/* Funnels due for a fresh set: live, with an Instagram link, and no
   snapshot in the last `minAgeDays`. Oldest first. */
export async function dueFunnels(svc: SupabaseClient, limit: number, minAgeDays = 6): Promise<Array<{ slug: string; igLink: string; username: string }>> {
  const { data: clients } = await svc.from("onebox_clients").select("slug, config, extras").eq("status", "live");
  const { data: snaps } = await svc.from("ig_snapshots").select("slug, taken_at").order("taken_at", { ascending: false }).limit(5000);
  const latest = new Map<string, string>();
  for (const s of snaps ?? []) if (!latest.has(String(s.slug))) latest.set(String(s.slug), String(s.taken_at));
  const cutoff = new Date(Date.now() - minAgeDays * 86400_000).toISOString().slice(0, 10);
  return (clients ?? [])
    .map((c) => {
      const cfg = (c.config ?? {}) as Record<string, string>;
      const ex = (c.extras ?? {}) as { template?: string; igWidgetOff?: boolean };
      const igLink = String(cfg.igLink ?? "").trim();
      return { slug: String(c.slug), igLink, username: usernameFromLink(igLink), b2b: ex.template === "b2b", off: !!ex.igWidgetOff, last: latest.get(String(c.slug)) ?? "" };
    })
    .filter((c) => c.username && !c.b2b && !c.off && c.last < cutoff)
    .sort((a, b) => a.last.localeCompare(b.last))
    .slice(0, limit)
    .map(({ slug, igLink, username }) => ({ slug, igLink, username }));
}
