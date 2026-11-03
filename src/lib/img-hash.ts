import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

/* The ffmpeg binary: shipped next to the function on Vercel (traced from
   node_modules — see next.config.mjs), the package's own download locally. */
export async function ffmpegPath(): Promise<string> {
  const p = path.join(process.cwd(), "node_modules", "ffmpeg-static", "ffmpeg");
  await fs.access(p);
  return p;
}

/* Picture fingerprint (owner 11/03/2026: "why does she have the same video
   2 times?"): artists often re-post the same photo or reel. dHash of the
   square centre (what the grid tile shows): 17×16 grey pixels, one bit per
   "brighter than the pixel to its right" → 256 bits as 64 hex characters.
   Calibrated on real pairs (11/03): the same picture re-posted, re-encoded
   or with a caption/text change scores 0–16; two different clients on the
   same branded before/after template 30+ (ig-arrange.ts → REPEAT_BITS).
   null when ffmpeg is missing or the input won't decode — the post is then
   never treated as a repeat by fingerprint, and the ig-fetch cron's spare
   time fills it in later. */
const W = 17, H = 16;
async function grayPixels(args: string[], stdin?: Buffer): Promise<Buffer | null> {
  let ff: string;
  try { ff = await ffmpegPath(); } catch { return null; }
  return new Promise<Buffer | null>((resolve) => {
    let p: ReturnType<typeof spawn>;
    try {
      p = spawn(ff, ["-v", "error", ...args, "-vf", `crop='min(iw,ih)':'min(iw,ih)',scale=${W}:${H}:flags=area,format=gray`, "-frames:v", "1", "-f", "rawvideo", "pipe:1"]);
    } catch { resolve(null); return; }
    const out: Buffer[] = [];
    const timer = setTimeout(() => { p.kill("SIGKILL"); resolve(null); }, 20_000);
    p.stdout?.on("data", (d: Buffer) => out.push(d));
    p.on("error", () => { clearTimeout(timer); resolve(null); });
    p.on("close", (code) => { clearTimeout(timer); resolve(code === 0 ? Buffer.concat(out) : null); });
    p.stdin?.on("error", () => { /* ffmpeg may stop reading early */ });
    p.stdin?.end(stdin);
  });
}
function toHash(px: Buffer | null): string | null {
  if (!px || px.length < W * H) return null;
  let hex = "";
  for (let r = 0; r < H; r++) {
    for (let half = 0; half < 2; half++) {
      let byte = 0;
      for (let c = half * 8; c < half * 8 + 8; c++) byte = (byte << 1) | (px[r * W + c] > px[r * W + c + 1] ? 1 : 0);
      hex += byte.toString(16).padStart(2, "0");
    }
  }
  return hex;
}

/* A picture (the downloaded file). */
export async function imageHash(buf: Buffer): Promise<string | null> {
  return toHash(await grayPixels(["-i", "pipe:0"], buf));
}

/* A reel: the frame 1 s in, so the same reel posted twice matches even
   when its tiles show different frames. Takes a URL (ffmpeg reads only the
   bytes it needs) or a local file. */
export async function videoHash(src: string): Promise<string | null> {
  return toHash(await grayPixels(["-ss", "1", "-i", src]));
}
