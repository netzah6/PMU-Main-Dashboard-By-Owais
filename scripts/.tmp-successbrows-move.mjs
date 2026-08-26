// Move approved Successbrows contacts to "Session Done✅" (user-approved
// 2026-08-26): the 6 strong + 3 likely session-done PLUS 5 touch-up
// requesters — but ONLY contacts that have a phone number (no-phone = booked
// via IG, not our ads → excluded per user). Phone comes from the live GHL
// contact record. Updates the existing opportunity or creates one. Verifies.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const SP = "/private/tmp/claude-501/-Users-netzahmizrahi-Run-Claude-Code-Here/e722a9e0-59c7-49fc-a4e2-4330b895a49e/scratchpad";
const LOC = "d39MSYEqIgdQczwHnhlL";
const PIPELINE = "NV6s30JmbjWdmzzyXqHb";
const SESSION_DONE = "0ea0885c-c3dd-41b8-9968-bf44061d9624";
const GHL = "https://services.leadconnectorhq.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CANDIDATES = [
  // strong + likely (approved earlier)
  "Vera Rogers", "Vanessa Carbajal", "Breana Trevino", "Heidi Juarez",
  "Maria Hernández", "Destiny Mena",
  "djdoesbeaute", "All Things Body Sculpting", "Maria S Jimenez-Morones",
  // touch-up requesters (approved with phone-only rule)
  "Debbie Chan", "Yesenia Vasquez Chavez", "MS.IGotChaBack", "Brittany Bowers", "Kristen Gonzalez",
].map((n) => n.toLowerCase());
const scan = readFileSync(`${SP}/successbrows-scan.jsonl`, "utf8").trim().split("\n").map(JSON.parse);
const targets = scan.filter((r) => CANDIDATES.includes((r.name ?? "").trim().toLowerCase()));
console.log(`names resolved: ${targets.length}/14`);
if (targets.length !== 14) {
  const found = targets.map((t) => t.name.toLowerCase());
  console.error("MISSING:", CANDIDATES.filter((c) => !found.includes(c)).join(", "));
  console.error("aborting, no writes done");
  process.exit(1);
}

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: oauth } = await sb.from("ghl_oauth").select("*").eq("id", 1).single();
const r = await fetch(`${GHL}/oauth/locationToken`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Version: "2021-07-28", Authorization: `Bearer ${oauth.access_token}` },
  body: new URLSearchParams({ companyId: oauth.company_id ?? "jU225y7HB756kCAH7d0X", locationId: LOC }),
});
const tok = (await r.json()).access_token;
if (!tok) { console.error("TOKEN MINT FAILED"); process.exit(1); }
const H = { Authorization: `Bearer ${tok}`, Version: "2021-07-28", Accept: "application/json", "Content-Type": "application/json" };

let moved = 0, skipped = 0;
for (const t of targets) {
  try {
    // Phone check from the live contact record
    const cj = await (await fetch(`${GHL}/contacts/${t.contactId}`, { headers: H })).json();
    const phone = cj.contact?.phone ?? cj.phone ?? null;
    if (!phone || !String(phone).trim()) {
      skipped++;
      console.log(`SKIP  ${t.name}: no phone number (IG booking) — left untouched`);
      await sleep(250);
      continue;
    }
    const sj = await (await fetch(`${GHL}/opportunities/search?location_id=${LOC}&contact_id=${t.contactId}`, { headers: H })).json();
    const opps = (sj.opportunities ?? []).sort((a, b) => Date.parse(b.updatedAt ?? 0) - Date.parse(a.updatedAt ?? 0));
    let oppId;
    if (opps.length) {
      oppId = opps[0].id;
      const before = opps[0].pipelineStageId;
      const u = await fetch(`${GHL}/opportunities/${oppId}`, {
        method: "PUT", headers: H,
        body: JSON.stringify({ pipelineId: PIPELINE, pipelineStageId: SESSION_DONE }),
      });
      const uj = await u.json().catch(() => ({}));
      console.log(`UPDATE ${t.name} (${phone}): opp ${oppId} ${before} -> SESSION_DONE | HTTP ${u.status}${u.ok ? "" : " | " + JSON.stringify(uj).slice(0, 150)}`);
    } else {
      const c = await fetch(`${GHL}/opportunities/`, {
        method: "POST", headers: H,
        body: JSON.stringify({ locationId: LOC, pipelineId: PIPELINE, pipelineStageId: SESSION_DONE, contactId: t.contactId, name: t.name, status: "open" }),
      });
      const cj2 = await c.json().catch(() => ({}));
      oppId = cj2.opportunity?.id ?? cj2.id;
      console.log(`CREATE ${t.name} (${phone}): opp ${oppId ?? "?"} in SESSION_DONE | HTTP ${c.status}${c.ok ? "" : " | " + JSON.stringify(cj2).slice(0, 200)}`);
    }
    if (oppId) {
      await sleep(300);
      const vj = await (await fetch(`${GHL}/opportunities/${oppId}`, { headers: H })).json();
      const st = vj.opportunity?.pipelineStageId ?? vj.pipelineStageId;
      const ok = st === SESSION_DONE;
      if (ok) moved++;
      console.log(`  VERIFY ${t.name}: ${ok ? "Session Done✅ ✓" : "UNEXPECTED: " + st}`);
    }
  } catch (e) {
    console.log(`ERROR ${t.name}: ${e.message}`);
  }
  await sleep(300);
}
console.log(`done — moved ${moved}, skipped (no phone) ${skipped}`);
