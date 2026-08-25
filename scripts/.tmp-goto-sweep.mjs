// Behavioral test for the missing "Go to" step in CC- Funnel Survey:
// a lead who got "NAME, my {AREA} schedule is filling up" and never replied
// should still get a follow-up ~3 days later (the Go-to jumps them there).
// Per account: compare follow-up rates for Lips/Eyeliner (branches that NEED
// the Go-to) vs Eyebrows (control branch that has the wait inline).
import { createClient } from "@supabase/supabase-js";
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
const env = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const SP = "/private/tmp/claude-501/-Users-netzahmizrahi-Run-Claude-Code-Here/e722a9e0-59c7-49fc-a4e2-4330b895a49e/scratchpad";
const OUT = `${SP}/goto-sweep.jsonl`;
writeFileSync(OUT, "");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: oauth } = await sb.from("ghl_oauth").select("*").eq("id", 1).single();
const targets = JSON.parse(readFileSync(`${SP}/ccfs-workflows.json`, "utf8")).filter((t) => t.loc);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86400000;

for (const t of targets) {
  try {
    const r = await fetch("https://services.leadconnectorhq.com/oauth/locationToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Version: "2021-07-28", Authorization: `Bearer ${oauth.access_token}` },
      body: new URLSearchParams({ companyId: oauth.company_id ?? "jU225y7HB756kCAH7d0X", locationId: t.loc }),
    });
    const tok = (await r.json()).access_token;
    if (!tok) { appendFileSync(OUT, JSON.stringify({ biz: t.biz, err: "mint" }) + "\n"); continue; }
    const H = { Authorization: `Bearer ${tok}`, Version: "2021-07-28", Accept: "application/json" };
    // two pages of recent conversations = up to 200
    let convs = [], cursor = null;
    for (let p = 0; p < 2; p++) {
      const url = `https://services.leadconnectorhq.com/conversations/search?locationId=${t.loc}&limit=100&sortBy=last_message_date&sort=desc` + (cursor ? `&startAfterDate=${cursor}` : "");
      const j = await (await fetch(url, { headers: H })).json();
      const batch = j.conversations ?? [];
      if (!batch.length) break;
      convs.push(...batch);
      cursor = batch[batch.length - 1].sort?.[0] ?? batch[batch.length - 1].lastMessageDate;
      if (batch.length < 100) break;
    }
    const stats = { Eyebrows: { n: 0, followed: 0, dead: [] }, Lips: { n: 0, followed: 0, dead: [] }, Eyeliner: { n: 0, followed: 0, dead: [] } };
    let fetched = 0;
    for (const c of convs) {
      if (fetched >= 120) break;
      fetched++;
      const mj = await (await fetch(`https://services.leadconnectorhq.com/conversations/${c.id}/messages?limit=60`, { headers: H })).json();
      const msgs = (mj.messages?.messages ?? mj.messages ?? []).filter((m) => (m.messageType ?? "").includes("SMS")).slice().reverse();
      const hit = msgs.find((m) => m.direction === "outbound" && /my (Eyebrows|Lips|Eyeliner) schedule is filling up/i.test(m.body ?? ""));
      if (!hit) { await sleep(80); continue; }
      const area = hit.body.match(/my (Eyebrows|Lips|Eyeliner) schedule/i)[1];
      const key = area[0].toUpperCase() + area.slice(1).toLowerCase();
      const at = new Date(hit.dateAdded).getTime();
      // exclude leads who replied within 3 days (AI takes over — follow-up not expected)
      const replied = msgs.some((m) => m.direction === "inbound" && new Date(m.dateAdded).getTime() > at && new Date(m.dateAdded).getTime() < at + 4 * DAY);
      if (replied) { await sleep(80); continue; }
      // the schedule message must be old enough for a follow-up to be due
      if (Date.now() - at < 4 * DAY) { await sleep(80); continue; }
      stats[key].n++;
      const followed = msgs.some((m) => m.direction === "outbound" && new Date(m.dateAdded).getTime() > at + 2 * DAY);
      if (followed) stats[key].followed++;
      else stats[key].dead.push(c.fullName || c.contactName || c.contactId);
      await sleep(80);
    }
    appendFileSync(OUT, JSON.stringify({ biz: t.biz, owner: t.owner, stats }) + "\n");
    console.log(`${t.biz}: EB ${stats.Eyebrows.followed}/${stats.Eyebrows.n} · Lips ${stats.Lips.followed}/${stats.Lips.n} · EL ${stats.Eyeliner.followed}/${stats.Eyeliner.n}`);
    await sleep(200);
  } catch (e) { appendFileSync(OUT, JSON.stringify({ biz: t.biz, err: String(e).slice(0, 120) }) + "\n"); }
}
console.log("SWEEP COMPLETE");
