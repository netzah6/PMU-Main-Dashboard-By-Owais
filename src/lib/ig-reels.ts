import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { rankPosts, type FeedPost, type IgFeed, type PostKind } from "@/lib/ig-arrange";

/* Playable reels in the in-house Instagram grid, for the whole fleet
   (owner, 10/28/2026, after the 5-client pilot: "use reels when they show
   real work, pictures otherwise"). Two steps:
   1. The Instagram fetch (ig-fetch.ts) copies each reel's video into our
      bucket the moment it is scraped (Instagram's video links expire) and
      saves it on the post as `video`, still showing its cover.
   2. This judge (cron /api/cron/ig-reels) takes 10 evenly spaced frames
      from inside the reel, shows them to Claude, and gets back the best
      frame for the tile + what it shows + whether the reel helps a lead
      book at all. Useful reels get that frame as their tile (covers are
      usually text cards or selfies); the rest are marked useful:false and
      sink behind every picture (ig-arrange.ts).
   Frames need ffmpeg: the static binary from the `ffmpeg-static` package,
   shipped with the cron function (next.config.mjs). */

const BUCKET = "onebox-ig";
const MODEL = process.env.IG_CLASSIFY_MODEL || "claude-opus-5-5";
const FRAMES = 10;
export const MAX_REEL_BYTES = 40_000_000;
export const MAX_REEL_SECONDS = 180;
const JUDGE_TRIES = 3;
/* Bump when the judge's brief changes: every reel judged under an older
   version is looked at again by the hourly cron (stored on the post as jv).
   10/28/2026: a stricter brief (strict labels + judging the visible center
   square) was tried and measured — first rows as leads see them were no
   better (43 vs 42 of 75 lead-worthy on the 25 funnels with flagged tiles;
   bad first rows come from feeds with little clean work, not from the
   judge), and it demoted some good tiles — so the pilot brief stays. */
export const JUDGE_VERSION = 1;
const run = promisify(execFile);

/* Instagram post URL → its short code ("…/p/DQ1x2y3/" → "DQ1x2y3"). */
export function postCode(url: string | undefined): string {
  return String(url ?? "").match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/)?.[1] ?? "";
}

/* Copy a reel's video into our bucket → public URL ("" when it can't be
   fetched, is not a video, or is too big — the post then stays a picture). */
export async function storeReelVideo(svc: SupabaseClient, slug: string, code: string, videoUrl: string): Promise<string> {
  if (!code || !videoUrl) return "";
  try {
    const r = await fetch(videoUrl, { headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15" }, signal: AbortSignal.timeout(45_000) });
    if (!r.ok || !/^video\//.test(r.headers.get("content-type") ?? "")) return "";
    if (Number(r.headers.get("content-length") ?? 0) > MAX_REEL_BYTES) return "";
    const body = Buffer.from(await r.arrayBuffer());
    if (body.length < 20_000 || body.length > MAX_REEL_BYTES) return "";
    const p = `${slug}/reels/${code}.mp4`;
    const { error } = await svc.storage.from(BUCKET).upload(p, body, { upsert: true, contentType: "video/mp4", cacheControl: "31536000" });
    return error ? "" : svc.storage.from(BUCKET).getPublicUrl(p).data.publicUrl;
  } catch { return ""; }
}

/* The ffmpeg binary: shipped next to the function on Vercel (traced from
   node_modules), the package's own download locally. */
async function ffmpegPath(): Promise<string> {
  const p = path.join(process.cwd(), "node_modules", "ffmpeg-static", "ffmpeg");
  await fs.access(p);
  return p;
}

type Frame = { n: number; t: number; tile: string; judge: string };

/* 10 frames from inside the video: a 720-wide copy for the tile and a
   360-wide copy for the judge (keeps the call small). */
async function extractFrames(ff: string, video: string, dir: string): Promise<{ dur: number; frames: Frame[] }> {
  /* `ffmpeg -i file` with no output exits non-zero but prints the duration. */
  const info = await run(ff, ["-hide_banner", "-i", video], { timeout: 20_000 }).then((r) => r.stderr, (e: { stderr?: string }) => e.stderr ?? "");
  const m = info.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const dur = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
  if (!(dur > 0)) throw new Error("no duration (not a playable video)");
  const frames: Frame[] = [];
  for (let i = 0; i < FRAMES; i++) {
    const t = (i + 0.5) * dur / FRAMES;
    const tile = path.join(dir, `t${i + 1}.jpg`), judge = path.join(dir, `j${i + 1}.jpg`);
    try {
      await run(ff, ["-v", "error", "-y", "-ss", t.toFixed(2), "-i", video,
        "-filter_complex", "[0:v]split=2[a][b];[a]scale='min(720,iw)':-2[t];[b]scale=360:-2[j]",
        "-map", "[t]", "-frames:v", "1", "-q:v", "3", tile,
        "-map", "[j]", "-frames:v", "1", "-q:v", "5", judge], { timeout: 20_000 });
      await fs.access(tile); await fs.access(judge);
      frames.push({ n: i + 1, t, tile, judge });
    } catch { /* a frame that won't decode is just left out */ }
  }
  if (frames.length < 3) throw new Error(`only ${frames.length} frames decoded`);
  return { dur, frames };
}

export type ReelVerdict = { bestFrame: number; kind: PostKind; pmu: boolean; q: number; useful: boolean; why: string };
const KINDS: PostKind[] = ["split_ba", "after_closeup", "during", "person", "flyer_text", "other"];

/* The same brief the pilot's reviewers used (10/28/2026). */
const SYSTEM = `A permanent-makeup (PMU: brows, lips, eyeliner) artist's Instagram shows as a 3x2 grid on the booking page of her lead funnel, right while a lead picks an appointment time. A reel's TILE shows one still picture (we choose which frame); tapping the tile plays the reel.
Research (853 feed pictures, 97 funnels): the first row matters most; finished work on a real client lifts "picked a time"; a flyer/text card or a selfie in the first row costs about a third of deposits. What should lead: finished work on a real client, no text on the picture, close-ups that show the brows/lips clearly (a close-up of the client's face that shows her new brows IS a result picture), true before/afters. What should not lead: flyers, price cards, memes, talking-to-camera selfies, personal-life content, needles/numbing/very pink fresh skin.
You get numbered frames taken evenly from inside one reel (you cannot play it) plus its caption. Judge only what is visibly on screen. Answer with JSON only, no prose:
{"bestFrame": <frame number to use as the tile — finished work, clearest, least text; prefer a split before/after frame if one exists; 0 if no frame shows PMU work>,
 "kind": "<what the CHOSEN frame shows: split_ba | after_closeup | during | person | flyer_text | other>",
 "pmu": <true if the reel shows permanent-makeup work at all>,
 "q": <1-5, how convincing the chosen frame looks to a woman deciding to book>,
 "useful": <true if this reel would help a lead decide to book (real PMU work clearly shown somewhere in it); false for personal life, pure promos, lash-only/nails-only, or work too unclear to see>,
 "why": "<= 25 words"}
kind meanings: split_ba = before and after side by side in one picture; after_closeup = finished brows/lips/liner clearly visible (incl. a face close-up showing the result); during = procedure in progress (tools, gloves, mapping, pigment); person = a person/selfie where the work is not the subject; flyer_text = mostly text/graphics; other = anything else.`;

async function judgeFrames(client: Anthropic, frames: Frame[], dur: number, caption: string): Promise<ReelVerdict> {
  const content: Anthropic.Messages.ContentBlockParam[] = [{ type: "text", text: `Reel, ${dur.toFixed(1)} s. Caption: ${JSON.stringify(caption.slice(0, 600))}` }];
  for (const f of frames) {
    content.push({ type: "text", text: `Frame ${f.n} (at ${f.t.toFixed(1)} s):` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await fs.readFile(f.judge)).toString("base64") } });
  }
  content.push({ type: "text", text: "Judge this reel. JSON only." });
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    ...({ output_config: { effort: "medium" } } as Record<string, unknown>),
    system: SYSTEM,
    messages: [{ role: "user", content }],
  });
  const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`${res.stop_reason}: ${text.slice(0, 120) || "(no text)"}`);
  const j = JSON.parse(m[0]) as Record<string, unknown>;
  const kind = KINDS.includes(j.kind as PostKind) ? (j.kind as PostKind) : "other";
  let best = Math.round(Number(j.bestFrame) || 0);
  if (!frames.some((f) => f.n === best)) best = 0;
  const useful = !!j.useful && best > 0;
  return { bestFrame: best, kind, pmu: !!j.pmu, q: Math.min(5, Math.max(1, Math.round(Number(j.q) || 3))), useful, why: String(j.why ?? "").slice(0, 200) };
}

/* Judge one stored reel. With `slug` (not dry) the chosen frame is saved
   to the bucket and its URL returned as `tile`. */
export async function judgeReel(
  client: Anthropic, videoUrl: string, caption: string, save?: { svc: SupabaseClient; slug: string; code: string },
): Promise<ReelVerdict & { tile?: string; dur: number }> {
  const ff = await ffmpegPath();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reel-"));
  try {
    const r = await fetch(videoUrl, { signal: AbortSignal.timeout(45_000) });
    if (!r.ok) throw new Error(`video ${r.status}`);
    const video = path.join(dir, "v.mp4");
    await fs.writeFile(video, Buffer.from(await r.arrayBuffer()));
    const { dur, frames } = await extractFrames(ff, video, dir);
    const v = await judgeFrames(client, frames, dur, caption);
    let tile: string | undefined;
    if (save && v.useful) {
      const f = frames.find((x) => x.n === v.bestFrame)!;
      const p = `${save.slug}/reels/${save.code}-f${v.bestFrame}.jpg`;
      const { error } = await save.svc.storage.from(BUCKET).upload(p, await fs.readFile(f.tile), { upsert: true, contentType: "image/jpeg", cacheControl: "31536000" });
      if (error) throw new Error(`tile upload: ${error.message}`);
      tile = save.svc.storage.from(BUCKET).getPublicUrl(p).data.publicUrl;
    }
    return { ...v, tile, dur };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/* A reel waiting for its frame-by-frame look. */
export const needsJudge = (p: FeedPost) => !!p.video && (p.useful === undefined || (p.jv ?? 1) < JUDGE_VERSION) && (p.jt ?? 0) < JUDGE_TRIES;

/* Live funnels with reels waiting, most waiting first. */
export async function pendingReelFunnels(svc: SupabaseClient, limit: number): Promise<Array<{ slug: string; n: number }>> {
  const { data } = await svc.from("onebox_clients").select("slug, extras").eq("status", "live");
  return (data ?? [])
    .map((c) => ({ slug: String(c.slug), n: ((c.extras as { igFeed?: IgFeed } | null)?.igFeed?.posts ?? []).filter(needsJudge).length }))
    .filter((c) => c.n > 0)
    .sort((a, b) => b.n - a.n || a.slug.localeCompare(b.slug))
    .slice(0, limit);
}

/* Judge every waiting reel of one funnel (4 at a time, until `deadline`),
   then write the verdicts back in one go — re-reading the feed first so a
   refresh or an owner pick in the meantime is not overwritten. */
export async function judgeFunnelReels(
  svc: SupabaseClient, slug: string, deadline: number, opts: { dry?: boolean; errors?: string[] } = {},
): Promise<Array<{ url: string } & Partial<ReelVerdict> & { error?: string }>> {
  const errors = opts.errors ?? [];
  if (!process.env.ANTHROPIC_API_KEY) { errors.push("no ANTHROPIC_API_KEY"); return []; }
  const { data: row } = await svc.from("onebox_clients").select("extras").eq("slug", slug).maybeSingle();
  const posts = ((row?.extras ?? {}) as { igFeed?: IgFeed }).igFeed?.posts ?? [];
  /* Dry run (a check, writes nothing): re-judge every reel, judged or not. */
  const todo = opts.dry ? posts.filter((p) => !!p.video).slice(0, 12) : posts.filter(needsJudge);
  if (!todo.length) return [];
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 3, timeout: 90_000 });
  const out: Array<{ url: string } & Partial<ReelVerdict> & { error?: string; tile?: string }> = [];
  const queue = [...todo];
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      if (Date.now() > deadline) break;
      try {
        const v = await judgeReel(client, p.video!, p.cap ?? "", opts.dry ? undefined : { svc, slug, code: postCode(p.url) || `x${Math.abs(hash(p.video!))}` });
        out.push({ url: p.url, ...v });
      } catch (e) {
        const msg = e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160);
        errors.push(`${slug}: ${msg}`);
        out.push({ url: p.url, error: msg });
      }
    }
  }));
  if (opts.dry || !out.length) return out;
  /* Write back onto the CURRENT feed (re-read: a refresh or an owner pick
     may have landed while the judge ran), matched by post URL. */
  const { data: fresh } = await svc.from("onebox_clients").select("extras").eq("slug", slug).maybeSingle();
  const extras = (fresh?.extras ?? {}) as Record<string, unknown> & { igFeed?: IgFeed };
  const feed = extras.igFeed;
  if (!feed?.posts?.length) return out;
  const byUrl = new Map(out.map((o) => [o.url, o]));
  for (const p of feed.posts) {
    const o = byUrl.get(p.url);
    if (!o || !needsJudge(p)) continue;
    if (o.error || o.useful === undefined) { p.jt = (p.jt ?? 0) + 1; continue; }
    p.useful = o.useful; p.kind = o.kind; p.pmu = o.pmu; p.q = o.q; p.reel = true; p.jv = JUDGE_VERSION;
    p.frame = o.useful ? o.bestFrame : 0;
    if (o.useful && o.tile) p.img = o.tile;
    delete p.jt;
  }
  const ordered = rankPosts(feed.posts);
  const { error } = await svc.from("onebox_clients").update({ extras: { ...extras, igFeed: { ...feed, posts: ordered, imgs: ordered.map((p) => p.img) } } }).eq("slug", slug);
  if (error) errors.push(`${slug}: write ${error.message}`);
  return out;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
