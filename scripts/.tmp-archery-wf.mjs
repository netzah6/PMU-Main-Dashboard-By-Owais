import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: oauth } = await sb.from("ghl_oauth").select("*").eq("id", 1).single();
const LOC = "ckGCT7olSu7fMmrGVNMj";
const r = await fetch("https://services.leadconnectorhq.com/oauth/locationToken", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Version: "2021-07-28", Authorization: `Bearer ${oauth.access_token}` },
  body: new URLSearchParams({ companyId: oauth.company_id ?? "jU225y7HB756kCAH7d0X", locationId: LOC }),
});
const tok = (await r.json()).access_token;
const wj = await (await fetch(`https://services.leadconnectorhq.com/workflows/?locationId=${LOC}`, { headers: { Authorization: `Bearer ${tok}`, Version: "2021-07-28", Accept: "application/json" } })).json();
for (const w of wj.workflows ?? []) console.log(`[${w.status}] ${w.name}`);
