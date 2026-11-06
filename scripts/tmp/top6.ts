import { createClient } from "@supabase/supabase-js";
import { arrangeFeed, type IgFeed } from "@/lib/ig-arrange";
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
(async () => {
  const { data } = await svc.from("onebox_clients").select("slug, extras").eq("status", "live");
  const out: unknown[] = [];
  for (const c of data ?? []) {
    const ex = c.extras as { igFeed?: IgFeed; igPicks?: never; igWidgetOff?: boolean; template?: string; igFrozen?: boolean };
    if (!ex?.igFeed || ex.igWidgetOff || ex.template === "b2b" || ex.igFrozen) continue;
    const a = arrangeFeed(ex.igFeed, ex.igPicks) as { imgs: string[] };
    const by = new Map((ex.igFeed.posts ?? []).map((p) => [p.img, p]));
    const six = a.imgs.slice(0, 6).map((u) => { const p = by.get(u); return { u, k: p?.kind ?? "?", pmu: p?.pmu }; });
    out.push({ slug: c.slug, nonPmu: six.filter((s) => s.pmu === false).length, six });
  }
  console.log(JSON.stringify(out));
})();
