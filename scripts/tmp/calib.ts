import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { ffmpegPath } from "@/lib/img-hash";
import type { IgFeed } from "@/lib/ig-arrange";
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function gray(buf: Buffer, w: number, h: number): Promise<Buffer> {
  const ff = await ffmpegPath();
  return new Promise((res) => { const p = spawn(ff, ["-v", "error", "-i", "pipe:0", "-vf", `crop='min(iw,ih)':'min(iw,ih)',scale=${w}:${h}:flags=area,format=gray`, "-frames:v", "1", "-f", "rawvideo", "pipe:1"]); const o: Buffer[] = []; p.stdout.on("data", (d) => o.push(d)); p.on("close", () => res(Buffer.concat(o))); p.stdin.end(buf); });
}
const dbits = (px: Buffer, w: number, h: number) => { const b: number[] = []; for (let r = 0; r < h; r++) for (let c = 0; c < w - 1; c++) b.push(px[r * w + c] > px[r * w + c + 1] ? 1 : 0); return b; };
const ham = (a: number[], b: number[]) => a.reduce((s, x, i) => s + (x ^ b[i]), 0);
const mad = (a: Buffer, b: Buffer) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
(async () => {
  const want: [string, string, string, string][] = [
    ["annie-eyelash-permanent-make-up-salon-inc", "/6.jpg", "/13.jpg", "DIFF"], ["candy-beauty-studio", "/3.jpg", "/9.jpg", "DIFF?"], ["nakkid-skinn-studio", "/10.jpg", "/22.jpg", "same photo diff text"],
    ["paynes-permanent-brows", "/9.jpg", "/10.jpg", "REPEAT"], ["the-healing-design", "/5.jpg", "/6.jpg", "REPEAT"], ["basic-beige-brows", "", "", ""],
  ];
  const { data } = await svc.from("onebox_clients").select("slug, extras").in("slug", want.map((w) => w[0]));
  const urls: [string, string, string][] = [];
  for (const [slug, a, b, lab] of want) {
    const f = (data!.find((x) => x.slug === slug)!.extras as { igFeed: IgFeed }).igFeed;
    if (!a) continue;
    const ua = f.posts!.find((p) => p.img.endsWith(a))?.img, ub = f.posts!.find((p) => p.img.endsWith(b))?.img;
    if (ua && ub) urls.push([`${slug} ${lab}`, ua, ub]); else console.log("missing", slug, a, b);
  }
  const B = "https://rtmiakhhohhfaqghieri.supabase.co/storage/v1/object/public/onebox-ig/";
  urls.push(["modern REPEAT", B + "modern-artistry-spa-wellness/reels/Ddun_wuPHGW-f4.jpg", B + "modern-artistry-spa-wellness/reels/DduRFz9zCas-f4.jpg"]);
  urls.push(["jacklyn REPEAT(text)", B + "jacklyn-beauty-spa/reels/De9orJOR0Uh-f10.jpg", B + "jacklyn-beauty-spa/reels/DfAJkIfxl56-f9.jpg"]);
  urls.push(["naples REPEAT", B + "naples-beauty/2026-10-28/11.jpg", B + "naples-beauty/2026-10-28/12.jpg"]);
  urls.push(["maria DIFF", B + "make-up-by-maria-blanco/2026-10-28/1.jpg", B + "make-up-by-maria-blanco/reels/Dc1h3UnAouA-f1.jpg"]);
  for (const [lab, a, b] of urls) {
    const [ba, bb] = await Promise.all([a, b].map(async (u) => Buffer.from(await (await fetch(u)).arrayBuffer())));
    const [a9, b9, a17, b17, a32, b32] = await Promise.all([gray(ba, 9, 8), gray(bb, 9, 8), gray(ba, 17, 16), gray(bb, 17, 16), gray(ba, 32, 32), gray(bb, 32, 32)]);
    console.log(lab.padEnd(48), "d64", ham(dbits(a9, 9, 8), dbits(b9, 9, 8)), "d256", ham(dbits(a17, 17, 16), dbits(b17, 17, 16)), "mad32", mad(a32, b32).toFixed(1));
  }
})();
