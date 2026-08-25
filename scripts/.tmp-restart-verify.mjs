// Re-examine "script restart" flags: separate legit re-signups (dormant gap
// before the 2nd intro) from true glitches (intro re-fired mid-conversation,
// client active within 48h before it).
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const SP = "/private/tmp/claude-501/-Users-netzahmizrahi-Run-Claude-Code-Here/e722a9e0-59c7-49fc-a4e2-4330b895a49e/scratchpad";
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: oauth } = await sb.from("ghl_oauth").select("*").eq("id", 1).single();

const targets = [];
for (const line of readFileSync(`${SP}/v3-audit.jsonl`, "utf8").split("\n").filter(Boolean)) {
  const r = JSON.parse(line);
  if (r.type === "flag" && r.flags.some((f) => f.f === "script_restart")) targets.push(r);
}
console.log("restart threads to verify:", targets.length);

// location id per business (from conversations table)
const locByOwner = new Map();
const mintCache = new Map();
const mint = async (loc) => {
  if (mintCache.has(loc)) return mintCache.get(loc);
  const r = await fetch("https://services.leadconnectorhq.com/oauth/locationToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Version: "2021-07-28", Authorization: `Bearer ${oauth.access_token}` },
    body: new URLSearchParams({ companyId: oauth.company_id ?? "jU225y7HB756kCAH7d0X", locationId: loc }),
  });
  const t = (await r.json()).access_token ?? null;
  mintCache.set(loc, t);
  return t;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const t of targets) {
  const { data: c } = await sb.from("ghl_conversations").select("location_id").eq("id", t.conv).limit(1);
  const loc = c?.[0]?.location_id;
  if (!loc) { console.log(`? no location | ${t.biz} / ${t.contact}`); continue; }
  const tok = await mint(loc);
  if (!tok) { console.log(`? mint fail | ${t.biz}`); continue; }
  const H = { Authorization: `Bearer ${tok}`, Version: "2021-07-28", Accept: "application/json" };
  const mj = await (await fetch(`https://services.leadconnectorhq.com/conversations/${t.conv}/messages?limit=80`, { headers: H })).json();
  const msgs = (mj.messages?.messages ?? mj.messages ?? []).filter((m) => (m.messageType ?? "").includes("SMS")).slice().reverse();
  const intros = msgs.filter((m) => m.direction === "outbound" && /is this .{2,20}\?|I just received a request/i.test(m.body ?? ""));
  if (intros.length < 2) { console.log(`LEGIT (1 intro) | ${t.biz} / ${t.contact}`); continue; }
  let verdict = "LEGIT-resignup";
  let detail = "";
  for (let i = 1; i < intros.length; i++) {
    const at = new Date(intros[i].dateAdded).getTime();
    const priorClient = msgs.filter((m) => m.direction === "inbound" && new Date(m.dateAdded).getTime() < at)
      .map((m) => new Date(m.dateAdded).getTime()).sort((a, b) => b - a)[0];
    if (priorClient && at - priorClient < 48 * 3600000) {
      verdict = "GLITCH-midconvo";
      detail = `2nd intro ${((at - priorClient) / 3600000).toFixed(1)}h after client's last msg (${intros[i].dateAdded.slice(0, 16)})`;
      break;
    }
  }
  console.log(`${verdict} | ${t.biz} / ${t.contact} ${detail}`);
  await sleep(150);
}
