// Sweep: mid-conversation AI silences. Pattern: the AI was actively talking
// (outbound within 15 min before the client's reply), the client replied with
// something engaged (not an opt-out), and then NO outbound for 3+ hours.
// For every hit, pull the contact's tags to test the "ai off" theory.
import { createClient } from "@supabase/supabase-js";
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
const env = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const SP = "/private/tmp/claude-501/-Users-netzahmizrahi-Run-Claude-Code-Here/e722a9e0-59c7-49fc-a4e2-4330b895a49e/scratchpad";
const OUT = `${SP}/ai-silence.jsonl`;
writeFileSync(OUT, "");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: oauth } = await sb.from("ghl_oauth").select("*").eq("id", 1).single();
const targets = JSON.parse(readFileSync(`${SP}/ccfs-workflows.json`, "utf8")).filter((t) => t.loc);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H_ = (tok) => ({ Authorization: `Bearer ${tok}`, Version: "2021-07-28", Accept: "application/json" });
const DAYS = 10 * 86400000, HOUR = 3600000;
const OPTOUT = /\b(stop|no thanks|not interested|unsubscribe|leave me alone|wrong number)\b/i;

for (const t of targets) {
  try {
    const r = await fetch("https://services.leadconnectorhq.com/oauth/locationToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Version: "2021-07-28", Authorization: `Bearer ${oauth.access_token}` },
      body: new URLSearchParams({ companyId: oauth.company_id ?? "jU225y7HB756kCAH7d0X", locationId: t.loc }),
    });
    const tok = (await r.json()).access_token;
    if (!tok) { appendFileSync(OUT, JSON.stringify({ err: "mint", biz: t.biz }) + "\n"); continue; }
    const H = H_(tok);
    const cj = await (await fetch(`https://services.leadconnectorhq.com/conversations/search?locationId=${t.loc}&limit=100&sortBy=last_message_date&sort=desc`, { headers: H })).json();
    const convs = (cj.conversations ?? []).filter((c) => Date.now() - new Date(c.lastMessageDate ?? 0).getTime() < DAYS);
    let fetched = 0;
    for (const c of convs) {
      if (fetched >= 45) break;
      fetched++;
      const mj = await (await fetch(`https://services.leadconnectorhq.com/conversations/${c.id}/messages?limit=50`, { headers: H })).json();
      const msgs = (mj.messages?.messages ?? mj.messages ?? []).filter((m) => (m.messageType ?? "").includes("SMS")).slice().reverse();
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (m.direction !== "inbound") continue;
        const at = new Date(m.dateAdded).getTime();
        if (Date.now() - at > DAYS) continue;
        if (OPTOUT.test(m.body ?? "")) continue;
        const prevOut = msgs.slice(0, i).reverse().find((x) => x.direction === "outbound");
        if (!prevOut || at - new Date(prevOut.dateAdded).getTime() > 15 * 60000) continue; // AI wasn't mid-conversation
        const nextOut = msgs.slice(i + 1).find((x) => x.direction === "outbound");
        const gap = nextOut ? new Date(nextOut.dateAdded).getTime() - at : Date.now() - at;
        if (gap < 3 * HOUR) continue;
        // hit — get tags
        let tags = [];
        try {
          const ctj = await (await fetch(`https://services.leadconnectorhq.com/contacts/${c.contactId}`, { headers: H })).json();
          tags = ctj.contact?.tags ?? [];
        } catch { /* best effort */ }
        appendFileSync(OUT, JSON.stringify({
          biz: t.biz, owner: t.owner, contact: c.fullName || c.contactName || c.contactId,
          conv: c.id, loc: t.loc, contactId: c.contactId,
          reply: (m.body ?? "").slice(0, 120), replyAt: m.dateAdded,
          gapHours: Math.round(gap / HOUR), resumed: !!nextOut,
          resumeSource: nextOut?.source ?? null, tags,
        }) + "\n");
        break; // one hit per conversation is enough
      }
      await sleep(70);
    }
    console.log(`done ${t.biz}`);
    await sleep(150);
  } catch (e) { appendFileSync(OUT, JSON.stringify({ err: String(e).slice(0, 100), biz: t.biz }) + "\n"); }
}
console.log("SWEEP COMPLETE");
