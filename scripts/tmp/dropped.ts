import { createClient } from "@supabase/supabase-js";
import { feedPosts, hashDistance, rankPosts, type IgFeed, type IgPicks } from "@/lib/ig-arrange";
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
(async () => {
  const { data } = await svc.from("onebox_clients").select("slug, extras").eq("status", "live");
  const out: unknown[] = [];
  for (const c of data ?? []) {
    const ex = c.extras as { igFeed?: IgFeed; igPicks?: IgPicks; igWidgetOff?: boolean; template?: string };
    if (!ex?.igFeed || ex.igWidgetOff || ex.template === "b2b") continue;
    const all = feedPosts(ex.igFeed);
    const hidden = new Set(ex.igPicks?.hidden ?? []), pinned = ex.igPicks?.pinned ?? [];
    const by = new Map(all.map((p) => [p.url, p]));
    const seq = [...pinned.map((u) => by.get(u)).filter((p) => p && !hidden.has(p.url)), ...rankPosts(all.filter((p) => !hidden.has(p.url) && !pinned.includes(p.url)))] as typeof all;
    const kept: typeof all = [];
    for (const p of seq) {
      const m = kept.find((k) => k.img === p.img || (p.dh && k.dh && hashDistance(p.dh, k.dh) <= 10));
      if (m && kept.length < 8) out.push({ slug: c.slug, d: m.img === p.img ? 0 : hashDistance(p.dh!, m.dh!), a: m.img, b: p.img, pos: kept.length + 1 });
      if (!m || hashDistance(p.dh ?? "", m.dh ?? "") > 5) kept.push(p);
    }
  }
  console.log(JSON.stringify(out));
})();
