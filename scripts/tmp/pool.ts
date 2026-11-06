import { createClient } from "@supabase/supabase-js";
import { feedPosts, type IgFeed } from "@/lib/ig-arrange";
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
(async () => {
  const slugs = process.argv.slice(2);
  const { data } = await svc.from("onebox_clients").select("slug, config, extras").in("slug", slugs);
  console.log(JSON.stringify((data ?? []).map((c) => {
    const ex = c.extras as { igFeed: IgFeed; igPicks?: unknown; igFetch?: unknown };
    return { slug: c.slug, ig: (c.config as Record<string, string>).igLink, fetch: ex.igFetch, at: ex.igFeed.at, picks: ex.igPicks,
      posts: feedPosts(ex.igFeed).map((p) => ({ img: p.img, url: p.url, kind: p.kind, pmu: p.pmu, q: p.q, video: !!p.video })) };
  })));
})();
