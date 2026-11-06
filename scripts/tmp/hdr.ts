import { createClient } from "@supabase/supabase-js";
import { refreshHeader } from "@/lib/ig-fetch";
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
(async () => {
  for (const slug of process.argv.slice(2)) {
    const { data } = await svc.from("onebox_clients").select("config").eq("slug", slug).maybeSingle();
    const ok = await refreshHeader(svc, slug, String((data?.config as Record<string, string>)?.igLink ?? ""));
    console.log(slug, ok);
  }
})();
