import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { arrangeFeed, type IgFeed } from "@/lib/ig-arrange";
import { patchExtras } from "@/lib/ig-fetch";
/* Turn a grid back on with a given pin/hide (tile numbers from the pool sheet). */
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
(async () => {
  const [poolPath, slug, pinS, hideS] = process.argv.slice(2);
  const p = (JSON.parse(readFileSync(poolPath, "utf8")) as { slug: string; posts: { url: string }[] }[]).find((x) => x.slug === slug)!;
  const n = (s: string) => (s ? s.split(",").map(Number).map((i) => p.posts[i - 1].url) : []);
  const { data } = await svc.from("onebox_clients").select("extras").eq("slug", slug).maybeSingle();
  const ex = data!.extras as { igFeed: IgFeed; igOffWhy?: string };
  const picks = { pinned: n(pinS), hidden: n(hideS) };
  const { igOffWhy: _drop, ...rest } = ex as Record<string, unknown>;
  void rest;
  console.log(slug, await patchExtras(svc, slug, { igWidgetOff: false, igOffWhy: null, igPicks: picks }) ?? "ok", arrangeFeed(ex.igFeed, picks).imgs.slice(0, 6).length, "tiles");
})();
