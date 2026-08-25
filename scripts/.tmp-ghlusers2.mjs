// GHL users (id/name/email) for the tasks account, via marketplace-app location token
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: oauth } = await sb.from("ghl_oauth").select("*").eq("id", 1).single();
const locationId = process.argv[2];
const r = await fetch("https://services.leadconnectorhq.com/oauth/locationToken", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Version: "2021-07-28", Authorization: `Bearer ${oauth.access_token}`, Accept: "application/json" },
  body: new URLSearchParams({ companyId: oauth.company_id ?? "jU225y7HB756kCAH7d0X", locationId }),
});
const j = await r.json();
if (!j.access_token) { console.log("mint failed", r.status, JSON.stringify(j).slice(0, 200)); process.exit(1); }
const ur = await fetch(`https://services.leadconnectorhq.com/users/?locationId=${locationId}`, { headers: { Authorization: `Bearer ${j.access_token}`, Version: "2021-07-28", Accept: "application/json" } });
console.log("users HTTP", ur.status);
const uj = await ur.json();
for (const u of uj.users ?? []) console.log(JSON.stringify({ id: u.id, name: u.name, email: u.email }));
if (!uj.users) console.log("RAW:", JSON.stringify(uj).slice(0, 300));
