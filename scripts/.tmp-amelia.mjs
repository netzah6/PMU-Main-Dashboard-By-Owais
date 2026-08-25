// Amelia Mora (Archery Brow Bar): full thread + contact tags to see why AI stopped.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: oauth } = await sb.from("ghl_oauth").select("*").eq("id", 1).single();
const LOC = "ckGCT7olSu7fMmrGVNMj", CONTACT = "DEiZz3e9hha9pD6Zwz4Y", CONV = "JLCNSTqI8WiFXytERIx8";
const r = await fetch("https://services.leadconnectorhq.com/oauth/locationToken", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Version: "2021-07-28", Authorization: `Bearer ${oauth.access_token}` },
  body: new URLSearchParams({ companyId: oauth.company_id ?? "jU225y7HB756kCAH7d0X", locationId: LOC }),
});
const tok = (await r.json()).access_token;
const H = { Authorization: `Bearer ${tok}`, Version: "2021-07-28", Accept: "application/json" };
const cj = await (await fetch(`https://services.leadconnectorhq.com/contacts/${CONTACT}`, { headers: H })).json();
console.log("TAGS:", JSON.stringify(cj.contact?.tags ?? []));
console.log("dateAdded:", cj.contact?.dateAdded, "| source:", cj.contact?.source);
const mj = await (await fetch(`https://services.leadconnectorhq.com/conversations/${CONV}/messages?limit=60`, { headers: H })).json();
const msgs = (mj.messages?.messages ?? mj.messages ?? []).filter((m) => (m.messageType ?? "").includes("SMS")).slice().reverse();
for (const m of msgs) {
  console.log(`${(m.dateAdded ?? "").slice(0, 16)} ${m.direction === "inbound" ? "CLIENT" : "OUT"}(${m.source ?? "?"}): ${(m.body ?? "").replace(/\s+/g, " ").slice(0, 150)}`);
}
