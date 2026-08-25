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

// paginate conversations via startAfterDate
let convs = [], cursor = null;
for (let p = 0; p < 4; p++) {
  const url = `https://services.leadconnectorhq.com/conversations/search?locationId=${LOC}&limit=100&sortBy=last_message_date&sort=desc` + (cursor ? `&startAfterDate=${cursor}` : "");
  const j = await (await fetch(url, { headers: H })).json();
  const batch = j.conversations ?? [];
  if (!batch.length) break;
  convs.push(...batch);
  cursor = batch[batch.length - 1].sort?.[0] ?? batch[batch.length - 1].lastMessageDate;
  if (!cursor || batch.length < 100) break;
}
console.log("total conversations:", convs.length);

const MARK = /\$\s?\d{2,4}|morning or afternoon|feels better for you|no pressure|had any permanent makeup|fully booked/i;
const results = [];
for (const c of convs) {
  const ms = await fetch(`https://services.leadconnectorhq.com/conversations/${c.id}/messages?limit=60`, { headers: H });
  const mj = await ms.json();
  const msgs = (mj.messages?.messages ?? mj.messages ?? []).filter((m) => (m.messageType ?? "").includes("SMS"));
  const chron = msgs.slice().reverse();
  const inb = chron.filter((m) => m.direction === "inbound").length;
  if (inb < 3) continue;
  const gaps = [];
  for (let i = 0; i < chron.length - 1; i++) {
    if (chron[i].direction === "inbound" && chron[i + 1].direction === "outbound") {
      gaps.push((new Date(chron[i + 1].dateAdded) - new Date(chron[i].dateAdded)) / 60000);
    }
  }
  gaps.sort((a, b) => a - b);
  const med = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 999;
  const marked = chron.some((m) => m.direction === "outbound" && MARK.test(m.body ?? ""));
  if (med <= 2 && marked) {
    results.push({ name: c.fullName || c.contactName || c.contactId, id: c.id, inb, med: med.toFixed(1), n: chron.length });
  }
}
for (const x of results) console.log(`CANDIDATE ${x.name} | conv ${x.id} | client msgs ${x.inb} | median reply ${x.med} min | total msgs ${x.n}`);
