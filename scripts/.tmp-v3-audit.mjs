// V3 deposit-blocker audit: sweep recent conversations in every live V3
// sub-account and flag anything that stops a client from booking/paying.
import { createClient } from "@supabase/supabase-js";
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
const env = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const OUT = process.argv[2] || "/tmp/v3-audit.jsonl";
writeFileSync(OUT, "");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: oauth } = await sb.from("ghl_oauth").select("*").eq("id", 1).single();

const { data: locs } = await sb.rpc; // placeholder no-op
const { data: clients } = await sb.from("clients_master").select("data").ilike("data->>Version", "%v3%");
const live = (clients ?? []).map((r) => r.data).filter((d) => String(d["col_1"] ?? "").trim().toLowerCase() === "live");
// map owner -> location via ghl_conversations
const targets = [];
for (const d of live) {
  const owner = String(d["Owner Full Name"] ?? "").trim();
  const { data: c } = await sb.from("ghl_conversations").select("location_id").eq("owner_key", owner.toLowerCase()).limit(1);
  if (c?.[0]?.location_id) targets.push({ owner, biz: String(d["Business Name"] ?? "").trim(), loc: c[0].location_id });
}
console.log("targets:", targets.length);

const mint = async (loc) => {
  const r = await fetch("https://services.leadconnectorhq.com/oauth/locationToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Version: "2021-07-28", Authorization: `Bearer ${oauth.access_token}` },
    body: new URLSearchParams({ companyId: oauth.company_id ?? "jU225y7HB756kCAH7d0X", locationId: loc }),
  });
  return (await r.json()).access_token ?? null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAYS14 = Date.now() - 14 * 86400000;
const COMPLAINT = /(not?\s?work|doesn'?t work|didn'?t work|won'?t (work|let|load|open)|can'?t (book|pay|open|click|access|get)|cannot|error|broken|invalid|expired|no answer|never (heard|got|received)|already (paid|sent|booked)|charged|wrong (link|number|time)|confus|glitch|tried to (book|pay)|link.{0,20}(dead|bad|not)|spam|scam|stop (text|messag)|real person|is this a bot|talking to a bot)/i;
const INTENT = /(book|appointment|schedule|deposit|how much|price|cost|pay)/i;

for (const t of targets) {
  try {
    const tok = await mint(t.loc);
    if (!tok) { appendFileSync(OUT, JSON.stringify({ type: "mint_fail", ...t }) + "\n"); continue; }
    const H = { Authorization: `Bearer ${tok}`, Version: "2021-07-28", Accept: "application/json" };
    const cj = await (await fetch(`https://services.leadconnectorhq.com/conversations/search?locationId=${t.loc}&limit=60&sortBy=last_message_date&sort=desc`, { headers: H })).json();
    const convs = (cj.conversations ?? []).filter((c) => new Date(c.lastMessageDate ?? 0).getTime() > DAYS14);
    let fetched = 0;
    for (const c of convs) {
      if (fetched >= 35) break;
      fetched++;
      const mj = await (await fetch(`https://services.leadconnectorhq.com/conversations/${c.id}/messages?limit=40`, { headers: H })).json();
      const msgs = (mj.messages?.messages ?? mj.messages ?? []).filter((m) => (m.messageType ?? "").includes("SMS")).slice().reverse();
      const inb = msgs.filter((m) => m.direction === "inbound");
      if (!inb.length) continue;
      const name = c.fullName || c.contactName || c.contactId;
      const flags = [];
      // 1. complaint keywords in client messages
      const complaints = inb.filter((m) => COMPLAINT.test(m.body ?? ""));
      if (complaints.length) flags.push({ f: "complaint", lines: complaints.map((m) => (m.body ?? "").slice(0, 200)) });
      // 2. dropped ball: last message is from the client, has intent, unanswered > 6h
      const last = msgs[msgs.length - 1];
      if (last?.direction === "inbound" && INTENT.test(last.body ?? "") && Date.now() - new Date(last.dateAdded).getTime() > 6 * 3600000) {
        flags.push({ f: "unanswered_intent", line: (last.body ?? "").slice(0, 200), since: last.dateAdded });
      }
      // 3. duplicate outbound (same body twice within 15 min)
      const outs = msgs.filter((m) => m.direction === "outbound" && (m.body ?? "").trim().length > 12);
      for (let i = 1; i < outs.length; i++) {
        if (outs[i].body === outs[i - 1].body && Math.abs(new Date(outs[i].dateAdded) - new Date(outs[i - 1].dateAdded)) < 15 * 60000) {
          flags.push({ f: "duplicate_send", line: (outs[i].body ?? "").slice(0, 120) });
          break;
        }
      }
      // 4. script restart: intro question re-sent later in the thread
      const intro = outs.filter((m) => /is this .{2,20}\?|I just received a request/i.test(m.body ?? ""));
      if (intro.length >= 2 && new Date(intro[intro.length - 1].dateAdded) - new Date(intro[0].dateAdded) > 3 * 86400000) {
        flags.push({ f: "script_restart", n: intro.length });
      }
      if (flags.length) {
        const excerpt = msgs.slice(-14).map((m) => `${(m.dateAdded ?? "").slice(0, 16)} ${m.direction === "inbound" ? "CLIENT" : "OUT"}: ${(m.body ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
        appendFileSync(OUT, JSON.stringify({ type: "flag", biz: t.biz, owner: t.owner, contact: name, conv: c.id, flags, excerpt }) + "\n");
      }
      await sleep(120);
    }
    console.log(`done ${t.biz} (${convs.length} recent threads)`);
    await sleep(250);
  } catch (e) {
    appendFileSync(OUT, JSON.stringify({ type: "error", biz: t.biz, err: String(e).slice(0, 150) }) + "\n");
  }
}
console.log("AUDIT COMPLETE");
