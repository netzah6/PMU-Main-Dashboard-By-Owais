// Identify AI-scripted threads: the V3 script's signature lines + same-minute reply cadence.
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
const cs = await fetch(`https://services.leadconnectorhq.com/conversations/search?locationId=${LOC}&limit=100&sortBy=last_message_date&sort=desc`, { headers: H });
const convs = ((await cs.json()).conversations) ?? [];

const SCRIPT = [
  /\$200 OFF for new clients/i,
  /fully booked for the next 3 weeks/i,
  /Do you prefer morning or afternoon/i,
  /Which one feels better for you/i,
  /no pressure to commit/i,
  /have you ever had any permanent makeup done/i,
];
for (const c of convs) {
  const ms = await fetch(`https://services.leadconnectorhq.com/conversations/${c.id}/messages?limit=60`, { headers: H });
  const mj = await ms.json();
  const msgs = (mj.messages?.messages ?? mj.messages ?? []).filter((m) => (m.messageType ?? "").includes("SMS"));
  const out = msgs.filter((m) => m.direction === "outbound");
  const hits = SCRIPT.filter((re) => out.some((m) => re.test(m.body ?? "")));
  const inb = msgs.filter((m) => m.direction === "inbound").length;
  if (hits.length >= 2) {
    // measure reply speed: median gap between a client msg and the next outbound
    const chron = msgs.slice().reverse();
    const gaps = [];
    for (let i = 0; i < chron.length - 1; i++) {
      if (chron[i].direction === "inbound" && chron[i + 1].direction === "outbound") {
        gaps.push((new Date(chron[i + 1].dateAdded) - new Date(chron[i].dateAdded)) / 60000);
      }
    }
    gaps.sort((a, b) => a - b);
    const med = gaps.length ? gaps[Math.floor(gaps.length / 2)].toFixed(1) : "?";
    console.log(`AI-SCRIPT ${c.fullName || c.contactName} | conv ${c.id} | client msgs ${inb} | script lines ${hits.length} | median reply ${med} min`);
  }
}
