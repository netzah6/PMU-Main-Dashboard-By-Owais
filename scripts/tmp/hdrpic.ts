import { createClient } from "@supabase/supabase-js";
import { patchExtras } from "@/lib/ig-fetch";
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
(async () => {
  const [slug, url] = process.argv.slice(2);
  const r = await fetch(url);
  const b = Buffer.from(await r.arrayBuffer());
  if (!r.ok || b.length < 1000) { console.log(slug, "download failed", r.status); return; }
  const path = `${slug}/${new Date().toISOString().slice(0, 10)}/profile.jpg`;
  const { error } = await svc.storage.from("onebox-ig").upload(path, b, { upsert: true, contentType: "image/jpeg" });
  if (error) { console.log(slug, error.message); return; }
  const pic = svc.storage.from("onebox-ig").getPublicUrl(path).data.publicUrl;
  const { data } = await svc.from("onebox_clients").select("extras").eq("slug", slug).maybeSingle();
  const feed = (data?.extras as { igFeed?: { profile?: Record<string, unknown> } }).igFeed!;
  console.log(slug, await patchExtras(svc, slug, { igFeed: { ...feed, profile: { ...feed.profile, pic } } }) ?? "ok", b.length);
})();
