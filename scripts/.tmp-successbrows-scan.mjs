// Deep scan: Successbrows (Aileen Chinchilla, d39MSYEqIgdQczwHnhlL).
// Pull ALL conversations live from GHL (not just the 200 synced), fetch each
// full message thread, and flag contacts NOT in a "done" stage (Session Done /
// Deposit Collected / 5 Stars) whose chat contains session-done or
// appointment clues. Output: scratchpad/successbrows-scan.jsonl + summary.
import { createClient } from "@supabase/supabase-js";
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";

const env = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const SP = "/private/tmp/claude-501/-Users-netzahmizrahi-Run-Claude-Code-Here/e722a9e0-59c7-49fc-a4e2-4330b895a49e/scratchpad";
const OUT = `${SP}/successbrows-scan.jsonl`;
writeFileSync(OUT, "");
const LOC = "d39MSYEqIgdQczwHnhlL";
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Token
const { data: oauth } = await sb.from("ghl_oauth").select("*").eq("id", 1).single();
const r = await fetch("https://services.leadconnectorhq.com/oauth/locationToken", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Version: "2021-07-28", Authorization: `Bearer ${oauth.access_token}` },
  body: new URLSearchParams({ companyId: oauth.company_id ?? "jU225y7HB756kCAH7d0X", locationId: LOC }),
});
const tok = (await r.json()).access_token;
if (!tok) { console.error("TOKEN MINT FAILED"); process.exit(1); }
const H = { Authorization: `Bearer ${tok}`, Version: "2021-07-28", Accept: "application/json" };

// 2. Stage names for this location + contact -> stage map from DB opportunities
const { data: stages } = await sb.from("ghl_stage_map").select("stage_id,stage_name").eq("location_id", LOC);
const stageName = new Map((stages ?? []).map((s) => [s.stage_id, s.stage_name]));
const { data: opps } = await sb.from("ghl_opportunities").select("contact_id,stage_id,status,raw").eq("location_id", LOC);
const contactStage = new Map();
for (const o of opps ?? []) {
  if (!o.contact_id) continue;
  const prev = contactStage.get(o.contact_id);
  const upd = o.raw?.updatedAt ? Date.parse(o.raw.updatedAt) : 0;
  if (!prev || upd > prev.upd) contactStage.set(o.contact_id, { name: stageName.get(o.stage_id) ?? o.stage_id, upd });
}
const DONE = /session\s*done|service\s*done|deposit\s*collected|5 ?stars|google review/i;

// 3. ALL conversations via startAfterDate paging
let all = [], startAfter = null;
for (let p = 0; p < 30; p++) {
  const u = `https://services.leadconnectorhq.com/conversations/search?locationId=${LOC}&limit=100&sortBy=last_message_date&sort=desc${startAfter ? `&startAfterDate=${startAfter}` : ""}`;
  const j = await (await fetch(u, { headers: { ...H, Version: "2021-04-15" } })).json();
  const convos = j.conversations ?? [];
  if (!convos.length) break;
  all.push(...convos);
  const last = convos[convos.length - 1];
  const lmd = Number(last.lastMessageDate);
  if (!lmd || convos.length < 100) break;
  startAfter = lmd;
  await sleep(120);
}
// Dedupe by id
const seen = new Set();
all = all.filter((c) => !seen.has(c.id) && seen.add(c.id));
console.log(`conversations fetched: ${all.length}`);

// 4. Clue patterns (inbound = client speaking; outbound = artist confirming)
const IN_SESSION = [
  [/\b(i'?m|im) (here|outside|parked|parking|at the (door|studio|suite))\b/i, "arrived"],
  [/\bon my way\b|\bomw\b|\brunning (a (bit|little) )?late\b|\bbe there (in|at|soon)\b/i, "en route"],
  [/\blove (them|my brows|it|how they)\b|\bthey (look|came out|turned out)\b|\bcame out (so|really)? ?(good|great|amazing|beautiful)\b/i, "post-session praise"],
  [/\bhealing\b|\baftercare\b|\bscabbing\b|\bpeeling\b|\bitch(y|ing)\b/i, "healing/aftercare talk"],
  [/\btouch ?-?up\b/i, "touch-up talk"],
  [/\bthank you (so much )?(again )?for (today|my brows|everything)\b/i, "post-session thanks"],
];
const IN_APPT = [
  [/\b(see you|c u|cya) (then|tomorrow|today|at|on|soon)\b/i, "see-you confirmation"],
  [/\bconfirm(ed|ing)?\b/i, "confirmation word"],
  [/\bmy appointment\b|\bmy appt\b/i, "mentions own appointment"],
  [/\bwhat time (is|was) my\b|\bwhere (are you located|do i go|is the studio)\b/i, "logistics question"],
  [/\b(deposit|zelle|venmo|cash ?app).{0,30}(sent|paid|done)\b|\b(sent|paid).{0,20}(the )?deposit\b/i, "says deposit paid"],
  [/\breschedul/i, "reschedule talk"],
];
const OUT_APPT = [
  [/\byou'?re (all )?(set|booked|confirmed)\b/i, "artist: booked/confirmed"],
  [/\b(your|the) appointment (is )?(confirmed|booked|set|scheduled)\b/i, "artist: appointment confirmed"],
  [/\bsee you (then|tomorrow|today|at|on)\b/i, "artist: see you"],
  [/\baddress is\b|\bsuite\b.{0,20}\b(106|#)\b/i, "artist sent address"],
];

// 5. Scan each conversation not in a DONE stage
let scanned = 0, flagged = 0;
for (const c of all) {
  const cid = c.contactId;
  const stage = cid ? (contactStage.get(cid)?.name ?? "(no pipeline stage)") : "(no contact)";
  if (DONE.test(stage)) continue; // already counted as done
  scanned++;
  let msgs = [];
  try {
    const mj = await (await fetch(`https://services.leadconnectorhq.com/conversations/${c.id}/messages?limit=100`, { headers: H })).json();
    msgs = (mj.messages?.messages ?? mj.messages ?? []);
  } catch { /* skip on error */ }
  const hits = [];
  for (const m of msgs) {
    const body = m.body ?? "";
    if (!body) continue;
    const sets = m.direction === "inbound" ? [...IN_SESSION.map((x) => [...x, "session"]), ...IN_APPT.map((x) => [...x, "appt"])] : OUT_APPT.map((x) => [...x, "appt"]);
    for (const [re, label, kind] of sets) {
      if (re.test(body)) hits.push({ kind, label, dir: m.direction, at: m.dateAdded, quote: body.slice(0, 160) });
    }
  }
  if (hits.length) {
    flagged++;
    const sessionHits = hits.filter((h) => h.kind === "session");
    appendFileSync(OUT, JSON.stringify({
      name: c.contactName ?? c.fullName ?? "(unknown)",
      contactId: cid, conversationId: c.id, stage,
      lastMessage: c.lastMessageDate,
      verdict: sessionHits.length ? "session-done clues" : "appointment clues",
      clueCount: hits.length,
      clues: hits.slice(0, 6),
    }) + "\n");
  }
  await sleep(130);
  if (scanned % 50 === 0) console.log(`scanned ${scanned}, flagged ${flagged}`);
}
console.log(`DONE. total convs=${all.length} scanned(not-done-stage)=${scanned} flagged=${flagged}`);
