import { createClient } from "@supabase/supabase-js";
import { patchExtras } from "@/lib/ig-fetch";
import type { IgFeed } from "@/lib/ig-arrange";
/* Clear every reel fingerprint (some came from blank first frames) and any
   picture fingerprint with almost no bits set (blank picture). */
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const bits = (h: string) => [...h].reduce((s, c) => s + [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4][parseInt(c, 16) & 15], 0);
(async () => {
  const { data } = await svc.from("onebox_clients").select("slug, extras").eq("status", "live");
  let v = 0, d = 0;
  for (const c of data ?? []) {
    const feed = (c.extras as { igFeed?: IgFeed })?.igFeed;
    if (!feed?.posts?.some((p) => (p.vh && p.vh.length !== 128) || (p.dh && p.dh.length === 64 && bits(p.dh) < 20))) continue;
    const posts = feed.posts.map((p) => { const q = { ...p }; if (q.vh && q.vh.length !== 128) { delete q.vh; v++; } if (q.dh && q.dh.length === 64 && bits(q.dh) < 20) { delete q.dh; delete q.dhFor; d++; } return q; });
    await patchExtras(svc, String(c.slug), { igFeed: { ...feed, posts } });
  }
  console.log({ reelsCleared: v, blankPictures: d });
})();
