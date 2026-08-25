// Pull recent two-way conversations from Proud Brow's sub-account and print
// the threads so we can identify AI (CloseBot) chats.
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
if (!tok) { console.log("mint failed"); process.exit(1); }
{
  const ur = await fetch(`https://services.leadconnectorhq.com/users/?locationId=${LOC}`, { headers: { Authorization: `Bearer ${tok}`, Version: "2021-07-28", Accept: "application/json" } });
  const uj = await ur.json();
  for (const u of uj.users ?? []) console.log("GHL-USER", u.id, "|", u.name, "|", u.email);
}
const H = { Authorization: `Bearer ${tok}`, Version: "2021-07-28", Accept: "application/json" };

const cs = await fetch(`https://services.leadconnectorhq.com/conversations/search?locationId=${LOC}&limit=20&sortBy=last_message_date&sort=desc`, { headers: H });
const cj = await cs.json();
for (const c of (cj.conversations ?? []).slice(0, 20)) {
  const ms = await fetch(`https://services.leadconnectorhq.com/conversations/${c.id}/messages?limit=40`, { headers: H });
  const mj = await ms.json();
  const msgs = (mj.messages?.messages ?? mj.messages ?? []).filter((m) => m.messageType?.includes("SMS") || m.type === 1);
  const inb = msgs.filter((m) => m.direction === "inbound").length;
  const out = msgs.filter((m) => m.direction === "outbound").length;
  if (inb >= 1 && out >= 2) {
    console.log(`\n=== ${c.fullName || c.contactName || c.contactId} (conv ${c.id}) inbound:${inb} outbound:${out}`);
    for (const m of msgs.slice().reverse().slice(-14)) {
      const who = m.direction === "inbound" ? "CLIENT" : `OUT[src=${m.source ?? "?"}${m.userId ? "" : ",nouser"}]`;
      console.log(`${(m.dateAdded ?? "").slice(0, 16)} ${who}: ${(m.body ?? "").replace(/\s+/g, " ").slice(0, 150)}`);
    }
  }
}
