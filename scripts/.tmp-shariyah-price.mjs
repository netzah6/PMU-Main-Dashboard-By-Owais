// Find Proud Brow threads where the outbound side quotes a price (the AI script
// shares pricing mid-chat) and a real back-and-forth exists.
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

// grab up to 100 most recent conversations
const convs = [];
const cs = await fetch(`https://services.leadconnectorhq.com/conversations/search?locationId=${LOC}&limit=100&sortBy=last_message_date&sort=desc`, { headers: H });
convs.push(...(((await cs.json()).conversations) ?? []));
console.log("conversations fetched:", convs.length);

const PRICE = /\$\s?\d{2,4}|price|deposit|investment|cost/i;
let found = 0;
for (const c of convs) {
  if (found >= 6) break;
  const ms = await fetch(`https://services.leadconnectorhq.com/conversations/${c.id}/messages?limit=60`, { headers: H });
  const mj = await ms.json();
  const msgs = (mj.messages?.messages ?? mj.messages ?? []).filter((m) => (m.messageType ?? "").includes("SMS"));
  const inb = msgs.filter((m) => m.direction === "inbound").length;
  const priceOut = msgs.filter((m) => m.direction === "outbound" && /\$\s?\d{2,4}/.test(m.body ?? ""));
  if (inb >= 2 && priceOut.length >= 1) {
    found++;
    console.log(`\n==== ${c.fullName || c.contactName || c.contactId} — conv ${c.id} (${inb} client msgs)`);
    const chron = msgs.slice().reverse();
    // print the stretch around the first price mention
    const pi = chron.findIndex((m) => m.direction === "outbound" && /\$\s?\d{2,4}/.test(m.body ?? ""));
    const from = Math.max(0, pi - 6);
    for (const m of chron.slice(from, pi + 7)) {
      const who = m.direction === "inbound" ? "CLIENT" : `OUT(${m.source ?? "?"})`;
      console.log(`  ${(m.dateAdded ?? "").slice(0, 16)} ${who}: ${(m.body ?? "").replace(/\s+/g, " ").slice(0, 170)}`);
    }
  }
}
console.log(`\nthreads with price quotes + real replies: ${found}`);
