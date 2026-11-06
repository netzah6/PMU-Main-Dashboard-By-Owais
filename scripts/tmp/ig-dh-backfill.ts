import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { arrangeFeed, rankPosts, type IgFeed, type FeedPost, type IgPicks } from "@/lib/ig-arrange";
import { ffmpegPath, imageHash } from "@/lib/img-hash";
import { postCode } from "@/lib/ig-reels";
/* 11/03/2026 one-off: (1) reels that shared a stored picture with another
   post get their own cover (a frame from their own video); (2) every post
   gets its fingerprint (dh). Usage: tsx ig-dh-backfill.ts [--dry] [slug…] */
const run = promisify(execFile);
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const BUCKET = "onebox-ig";
const get = async (u: string) => { try { const r = await fetch(u, { signal: AbortSignal.timeout(30_000) }); return r.ok ? Buffer.from(await r.arrayBuffer()) : null; } catch { return null; } };
async function pool<T>(items: T[], n: number, f: (x: T) => Promise<void>) { const q = [...items]; await Promise.all(Array.from({ length: n }, async () => { for (let x = q.shift(); x !== undefined; x = q.shift()) await f(x); })); }
(async () => {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const only = args.filter((a) => !a.startsWith("--"));
  const ff = await ffmpegPath();
  let q = svc.from("onebox_clients").select("slug, extras").eq("status", "live");
  if (only.length) q = q.in("slug", only);
  const { data } = await q;
  let covers = 0, hashed = 0, fails = 0;
  const report: Record<string, { covers: number; beforeRepeats: number; afterShown: number }> = {};
  for (const c of data ?? []) {
    const slug = String(c.slug);
    const feed = (c.extras as { igFeed?: IgFeed })?.igFeed;
    if (!feed?.posts?.length) continue;
    const posts = feed.posts;
    const count = new Map<string, number>();
    for (const p of posts) count.set(p.img, (count.get(p.img) ?? 0) + 1);
    const shared = posts.filter((p) => (count.get(p.img) ?? 0) > 1 && p.video && p.useful !== true);
    const before = arrangeFeed(feed, (c.extras as { igPicks?: IgPicks }).igPicks).imgs.slice(0, 6);
    let nc = 0;
    for (const p of shared) {
      const code = postCode(p.url); if (!code) continue;
      const vid = await get(p.video!); if (!vid) { fails++; continue; }
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cov-"));
      try {
        await fs.writeFile(path.join(dir, "v.mp4"), vid);
        await run(ff, ["-v", "error", "-y", "-ss", "0.5", "-i", path.join(dir, "v.mp4"), "-vf", "scale='min(720,iw)':-2", "-frames:v", "1", "-q:v", "3", path.join(dir, "c.jpg")], { timeout: 30_000 });
        const body = await fs.readFile(path.join(dir, "c.jpg"));
        const key = `${slug}/reels/${code}-c.jpg`;
        if (!dry) {
          const { error } = await svc.storage.from(BUCKET).upload(key, body, { upsert: true, contentType: "image/jpeg", cacheControl: "31536000" });
          if (error) { fails++; continue; }
        }
        p.img = svc.storage.from(BUCKET).getPublicUrl(key).data.publicUrl;
        p.dh = (await imageHash(body)) ?? undefined;
        nc++; covers++;
      } catch { fails++; } finally { await fs.rm(dir, { recursive: true, force: true }); }
    }
    await pool(posts.filter((p) => !p.dh), 8, async (p: FeedPost) => {
      const b = await get(p.img); const h = b ? await imageHash(b) : null;
      if (h) { p.dh = h; hashed++; } else fails++;
    });
    /* Write back onto the CURRENT row, matched by post URL (a pick or a
       judge may have landed meanwhile). */
    const { data: fresh } = await svc.from("onebox_clients").select("extras").eq("slug", slug).maybeSingle();
    const ex = (fresh?.extras ?? {}) as Record<string, unknown> & { igFeed?: IgFeed; igPicks?: IgPicks };
    if (!ex.igFeed?.posts?.length) continue;
    const by = new Map(posts.map((p) => [p.url, p]));
    const merged = ex.igFeed.posts.map((p) => { const n = by.get(p.url); return n ? { ...p, img: n.img, ...(n.dh ? { dh: n.dh } : {}) } : p; });
    const ordered = rankPosts(merged);
    const nf = { ...ex.igFeed, posts: ordered, imgs: ordered.map((p) => p.img) };
    const after = arrangeFeed(nf, ex.igPicks).imgs.slice(0, 6);
    report[slug] = { covers: nc, beforeRepeats: before.length - new Set(before).size, afterShown: after.length };
    if (!dry) {
      const { error } = await svc.from("onebox_clients").update({ extras: { ...ex, igFeed: nf } }).eq("slug", slug);
      if (error) { console.log(slug, "write", error.message); fails++; }
    }
  }
  console.log(JSON.stringify({ covers, hashed, fails, changed: Object.fromEntries(Object.entries(report).filter(([, r]) => r.covers || r.beforeRepeats || r.afterShown < 6)) }, null, 1));
})();
