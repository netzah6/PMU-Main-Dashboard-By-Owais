// READ-ONLY verify: print current pipeline stage for the 9 approved contacts.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const SP = "/private/tmp/claude-501/-Users-netzahmizrahi-Run-Claude-Code-Here/e722a9e0-59c7-49fc-a4e2-4330b895a49e/scratchpad";
const LOC = "d39MSYEqIgdQczwHnhlL";
const GHL = "https://services.leadconnectorhq.com";
const NAMES = { "0ea0885c-c3dd-41b8-9968-bf44061d9624": "Session Done✅" };
const APPROVED = ["Vera Rogers","Vanessa Carbajal","Breana Trevino","Heidi Juarez","Maria Hernández","Destiny Mena","djdoesbeaute","All Things Body Sculpting","Maria S Jimenez-Morones"];
const APPROVED_LC = new Set([...APPROVED].map((n) => n.toLowerCase()));
const scan = readFileSync(`${SP}/successbrows-scan.jsonl`, "utf8").trim().split("\n").map(JSON.parse);
const targets = scan.filter((r) => APPROVED.map((n)=>n.toLowerCase()).includes((r.name ?? "").trim().toLowerCase()));
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: oauth } = await sb.from("ghl_oauth").select("*").eq("id", 1).single();
const r = await fetch(`${GHL}/oauth/locationToken`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Version: "2021-07-28", Authorization: `Bearer ${oauth.access_token}` },
  body: new URLSearchParams({ companyId: oauth.company_id ?? "jU225y7HB756kCAH7d0X", locationId: LOC }),
});
const tok = (await r.json()).access_token;
const H = { Authorization: `Bearer ${tok}`, Version: "2021-07-28", Accept: "application/json" };
const { data: stages } = await sb.from("ghl_stage_map").select("stage_id,stage_name").eq("location_id", LOC);
for (const s of stages ?? []) NAMES[s.stage_id] = s.stage_name;
for (const t of targets) {
  const sj = await (await fetch(`${GHL}/opportunities/search?location_id=${LOC}&contact_id=${t.contactId}`, { headers: H })).json();
  const opps = (sj.opportunities ?? []).sort((a, b) => Date.parse(b.updatedAt ?? 0) - Date.parse(a.updatedAt ?? 0));
  const st = opps[0]?.pipelineStageId;
  console.log(`${t.name}: ${opps.length ? (NAMES[st] ?? st) : "NO OPPORTUNITY"}`);
  await new Promise((res) => setTimeout(res, 200));
}
