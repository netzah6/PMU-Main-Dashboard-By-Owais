import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { arrangeFeed, feedPosts, type IgFeed, type IgPicks } from "@/lib/ig-arrange";
import { patchExtras } from "@/lib/ig-fetch";
/* 11/03/2026 owner: "why does her feed only show lashes?" — apply the
   vision re-pick of weak grids. Usage: tsx repick-apply.ts pool.json decisions.json [--dry] */
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
type Dec = { slug: string; pin: number[]; hide: number[]; switchOff: boolean };
(async () => {
  const [poolPath, decPath, flag] = process.argv.slice(2);
  const pool = JSON.parse(readFileSync(poolPath, "utf8")) as { slug: string; posts: { url: string; img: string }[] }[];
  const decs = JSON.parse(readFileSync(decPath, "utf8")) as Dec[];
  for (const d of decs) {
    const p = pool.find((x) => x.slug === d.slug)!;
    const { data } = await svc.from("onebox_clients").select("extras").eq("slug", d.slug).maybeSingle();
    const ex = data!.extras as { igFeed: IgFeed; igPicks?: IgPicks };
    const live = feedPosts(ex.igFeed);
    const liveUrls = new Set(live.map((x) => x.url));
    const url = (n: number) => p.posts[n - 1]?.url ?? "";
    /* The sheet must still match the stored pool (a fetch in between would shift numbers). */
    if (p.posts.some((x) => !liveUrls.has(x.url)) || live.length !== p.posts.length) { console.log(d.slug, "POOL CHANGED — skipped"); continue; }
    if (d.switchOff || d.pin.length < 3) {
      console.log(d.slug, "→ Instagram section OFF");
      if (flag !== "--dry") await patchExtras(svc, d.slug, { igWidgetOff: true, igOffWhy: "11/03/2026: fewer than 3 permanent-makeup pictures on their Instagram" });
      continue;
    }
    /* A full grid (6) or one clean row (3) — never a jagged 4 or 5. */
    const pin = (d.pin.length >= 6 ? d.pin.slice(0, 6) : d.pin.slice(0, 3)).map(url).filter(Boolean);
    const hide = new Set([...(ex.igPicks?.hidden ?? []).filter((u) => liveUrls.has(u)), ...d.hide.map(url).filter(Boolean)]);
    for (const u of pin) hide.delete(u);
    if (pin.length < 6) for (const x of live) if (!pin.includes(x.url)) hide.add(x.url);
    const picks: IgPicks = { pinned: pin, hidden: [...hide] };
    const shown = arrangeFeed(ex.igFeed, picks).imgs.slice(0, 6);
    console.log(d.slug, `pin ${pin.length}, hide ${hide.size}, shows ${shown.length}`, shown.every((u, i) => i >= pin.length || u === live.find((x) => x.url === pin[i])!.img) ? "order ok" : "ORDER MISMATCH");
    if (flag !== "--dry") await patchExtras(svc, d.slug, { igPicks: picks });
  }
})();
