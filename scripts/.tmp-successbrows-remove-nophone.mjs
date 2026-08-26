// Remove the 4 NO-PHONE opportunity cards from Session Done (user-approved
// 2026-08-26). These exact cards were created by our own move script earlier
// today (the contacts had no opportunity before), so this only undoes that.
// Deletes are pinned to exact opportunity IDs — nothing else can be touched.
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
const TARGETS = [
  { name: "Maria S Jimenez-Morones", opp: "soUjQHjPCA3TWsFwOOBr" },
  { name: "All Things Body Sculpting", opp: "YDBf4WqORakcnShxFfwx" },
  { name: "djdoesbeaute", opp: "s0s0Eh3td7ZyiLIAWjhF" },
  { name: "Destiny Mena", opp: "CffFff4o2qWjZnzaIFFp" },
];
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: oauth } = await sb.from("ghl_oauth").select("*").eq("id", 1).single();
const r = await fetch(`${GHL}/oauth/locationToken`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Version: "2021-07-28", Authorization: `Bearer ${oauth.access_token}` },
  body: new URLSearchParams({ companyId: oauth.company_id ?? "jU225y7HB756kCAH7d0X", locationId: LOC }),
});
const tok = (await r.json()).access_token;
if (!tok) { console.error("TOKEN MINT FAILED"); process.exit(1); }
const H = { Authorization: `Bearer ${tok}`, Version: "2021-07-28", Accept: "application/json" };
for (const t of TARGETS) {
  // Safety: confirm the card is still in Session Done and has no phone before deleting
  const vj = await (await fetch(`${GHL}/opportunities/${t.opp}`, { headers: H })).json();
  const o = vj.opportunity ?? vj;
  const st = o.pipelineStageId;
  if (st !== SESSION_DONE) { console.log(`SKIP ${t.name}: not in Session Done anymore (${st})`); continue; }
  const cj = await (await fetch(`${GHL}/contacts/${o.contactId}`, { headers: H })).json();
  const phone = cj.contact?.phone ?? null;
  if (phone && String(phone).trim()) { console.log(`SKIP ${t.name}: has phone ${phone} — not removing`); continue; }
  const d = await fetch(`${GHL}/opportunities/${t.opp}`, { method: "DELETE", headers: H });
  console.log(`DELETE ${t.name}: opp ${t.opp} | HTTP ${d.status} ${d.ok ? "✓" : ""}`);
  await sleep(300);
}
// Final state
const j = await (await fetch(`${GHL}/opportunities/search?location_id=${LOC}&pipeline_id=NV6s30JmbjWdmzzyXqHb&pipeline_stage_id=${SESSION_DONE}&limit=100`, { headers: H })).json();
console.log(`Session Done now has ${(j.opportunities ?? []).length} cards:`);
for (const o of j.opportunities ?? []) console.log(" -", o.name ?? "?");
