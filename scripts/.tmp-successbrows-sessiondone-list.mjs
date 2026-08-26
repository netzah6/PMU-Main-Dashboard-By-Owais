// READ-ONLY: list every opportunity currently in "Session Done✅" for
// Successbrows, with each contact's phone (live), flagging no-phone ones.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const LOC = "d39MSYEqIgdQczwHnhlL";
const SESSION_DONE = "0ea0885c-c3dd-41b8-9968-bf44061d9624";
const GHL = "https://services.leadconnectorhq.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: oauth } = await sb.from("ghl_oauth").select("*").eq("id", 1).single();
const r = await fetch(`${GHL}/oauth/locationToken`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Version: "2021-07-28", Authorization: `Bearer ${oauth.access_token}` },
  body: new URLSearchParams({ companyId: oauth.company_id ?? "jU225y7HB756kCAH7d0X", locationId: LOC }),
});
const tok = (await r.json()).access_token;
const H = { Authorization: `Bearer ${tok}`, Version: "2021-07-28", Accept: "application/json" };
let page = `${GHL}/opportunities/search?location_id=${LOC}&pipeline_id=NV6s30JmbjWdmzzyXqHb&pipeline_stage_id=${SESSION_DONE}&limit=100`;
const rows = [];
for (let p = 0; p < 10 && page; p++) {
  const j = await (await fetch(page, { headers: H })).json();
  const opps = j.opportunities ?? [];
  for (const o of opps) rows.push(o);
  page = j.meta?.nextPageUrl ?? null;
  await sleep(150);
}
console.log(`opportunities in Session Done: ${rows.length}`);
let noPhone = 0;
for (const o of rows) {
  let phone = o.contact?.phone ?? null;
  if (phone === null && o.contactId) {
    const cj = await (await fetch(`${GHL}/contacts/${o.contactId}`, { headers: H })).json();
    phone = cj.contact?.phone ?? null;
    await sleep(150);
  }
  const has = phone && String(phone).trim();
  if (!has) noPhone++;
  console.log(`${has ? "PHONE " : "NOPHONE"} | ${o.name ?? o.contact?.name ?? "?"} | ${phone ?? "-"} | opp ${o.id}`);
}
console.log(`summary: ${rows.length} total, ${noPhone} without phone`);
