import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const LOC = "Ky8VWxGCAqwVAJE2xbgz";
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: oauth } = await sb.from("ghl_oauth").select("*").eq("id", 1).single();
const r = await fetch("https://services.leadconnectorhq.com/oauth/locationToken", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Version: "2021-07-28", Authorization: `Bearer ${oauth.access_token}` },
  body: new URLSearchParams({ companyId: oauth.company_id ?? "jU225y7HB756kCAH7d0X", locationId: LOC }),
});
const tok = (await r.json()).access_token;
const H = { Authorization: `Bearer ${tok}`, Version: "2021-07-28", Accept: "application/json" };
const TARGETS = [
  ["Neeru Setia", "seBkK3DbAjmW8SKRpDI2"],
  ["Amy Hansen", "uk17jh5f05jWpAZgVTae"],
  ["Aura Ghiringhelli", "BwdIm06bUI5HM17xodvp"],
  ["Stephy Diaz", "NnXVNCHP4MqD4A35pcDx"],
  ["Deborah", "lBuRBuB0E2YTkjSkBdpe"],
];
for (const [name, id] of TARGETS) {
  const mj = await (await fetch(`https://services.leadconnectorhq.com/conversations/${id}/messages?limit=60`, { headers: H })).json();
  const msgs = (mj.messages?.messages ?? mj.messages ?? []).filter((m) => (m.messageType ?? "").includes("SMS")).slice().reverse();
  console.log(`\n======== ${name} (${id})`);
  for (const m of msgs.slice(0, 26)) {
    const who = m.direction === "inbound" ? "CLIENT" : "OUT";
    console.log(`  ${(m.dateAdded ?? "").slice(0, 16)} ${who}: ${(m.body ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
  }
}
