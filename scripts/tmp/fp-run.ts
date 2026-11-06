import { createClient } from "@supabase/supabase-js";
import { fingerprintFeeds } from "@/lib/ig-fetch";
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
(async () => { console.log(JSON.stringify(await fingerprintFeeds(svc, Date.now() + 40 * 60_000))); })();
