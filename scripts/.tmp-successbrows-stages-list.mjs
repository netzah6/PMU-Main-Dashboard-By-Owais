// READ-ONLY: list Successbrows opportunities in Deposit Collected, Session
// Done and 5 Stars Google Review, with phone from the opp's embedded contact
// (fallback: live contact fetch).
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const LOC = "d39MSYEqIgdQczwHnhlL";
const PIPE = "NV6s30JmbjWdmzzyXqHb";
const STAGES = [
  ["Deposit Collected😍", "465645ca-24e7-4d6f-b96e-e24fe905f7b2"],
  ["Session Done✅", "0ea0885c-c3dd-41b8-9968-bf44061d9624"],
  ["5 Stars Google Review⭐", "3f613bb5-1610-46b8-aa05-bdc984db079d"],
];
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
for (const [name, id] of STAGES) {
  let page = `${GHL}/opportunities/search?location_id=${LOC}&pipeline_id=${PIPE}&pipeline_stage_id=${id}&limit=100`;
  const rows = [];
  for (let p = 0; p < 10 && page; p++) {
    const j = await (await fetch(page, { headers: H })).json();
    rows.push(...(j.opportunities ?? []));
    page = j.meta?.nextPageUrl ?? null;
    await sleep(120);
  }
  console.log(`\n===== ${name} (${rows.length}) =====`);
  for (const o of rows) {
    let phone = o.contact?.phone ?? null;
    if (phone === null && o.contactId) {
      const cj = await (await fetch(`${GHL}/contacts/${o.contactId}`, { headers: H })).json();
      phone = cj.contact?.phone ?? null;
      await sleep(120);
    }
    const created = (o.createdAt ?? "").slice(0, 10);
    console.log(`${o.name ?? o.contact?.name ?? "?"} | ${phone ?? "no phone"} | added ${created}`);
  }
}
