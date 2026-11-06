import { createClient } from "@supabase/supabase-js";
import { arrangeFeed, feedPosts, isRepeat, rankPosts, type IgFeed, type IgPicks } from "@/lib/ig-arrange";
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
(async () => {
  const { data } = await svc.from("onebox_clients").select("slug, extras").eq("status", "live");
  const out: unknown[] = []; let funnels = 0;
  for (const c of data ?? []) {
    const ex = c.extras as { igFeed?: IgFeed; igPicks?: IgPicks; igWidgetOff?: boolean; template?: string; igFrozen?: boolean };
    if (!ex?.igFeed || ex.igWidgetOff || ex.template === "b2b" || ex.igFrozen) continue;
    funnels++;
    const all = feedPosts(ex.igFeed);
    const hidden = new Set(ex.igPicks?.hidden ?? []), pinned = ex.igPicks?.pinned ?? [];
    const by = new Map(all.map((p) => [p.url, p]));
    const old = [...pinned.map((u) => by.get(u)!).filter((p) => p && !hidden.has(p.url)), ...rankPosts(all.filter((p) => !hidden.has(p.url) && !pinned.includes(p.url)))].slice(0, 6);
    const now = (arrangeFeed(ex.igFeed, ex.igPicks).posts ?? []).slice(0, 6);
    for (const p of old) if (!now.some((n) => n.img === p.img && n.url === p.url)) {
      const m = [...now, ...all.filter((x) => hidden.has(x.url))].find((k) => k !== p && isRepeat(p, k));
      out.push({ slug: c.slug, a: m?.img ?? "?", b: p.img, why: m ? (m.img === p.img ? "img" : p.vh && m.vh ? "vh/dh" : "dh") : "pushed" });
    }
  }
  console.log(JSON.stringify({ funnels, dropped: out }));
})();
