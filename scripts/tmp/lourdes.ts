import { createClient } from "@supabase/supabase-js";
import { hashDistance, type IgFeed } from "@/lib/ig-arrange";
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
(async () => {
  const { data } = await svc.from("onebox_clients").select("extras").eq("slug", "lourdes-beauty-pmu-lashes").single();
  const ps = (data!.extras as { igFeed: IgFeed }).igFeed.posts!;
  const a = ps.find((p) => p.img.includes("DdonuohOLuX"))!;
  for (const p of ps) if (p !== a && p.vh && a.vh) { const d1 = hashDistance(a.vh.slice(0, 64), p.vh.slice(0, 64)), d2 = hashDistance(a.vh.slice(64), p.vh.slice(64)), dd = a.dh && p.dh ? hashDistance(a.dh, p.dh) : -1; if (d1 <= 30 || dd <= 30) console.log(p.img.slice(-40), "vh1", d1, "vh5", d2, "dh", dd); }
})();
