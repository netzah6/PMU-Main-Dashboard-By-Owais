// Which live V3 accounts are missing (or have unpublished) the
// "Extensions - Follow Up Nurture (V3)" workflow.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: oauth } = await sb.from("ghl_oauth").select("*").eq("id", 1).single();
const { data: clients } = await sb.from("clients_master").select("data").ilike("data->>Version", "%v3%");
const live = (clients ?? []).map((r) => r.data).filter((d) => String(d["col_1"] ?? "").trim().toLowerCase() === "live");
const targets = [];
for (const d of live) {
  const owner = String(d["Owner Full Name"] ?? "").trim();
  const { data: c } = await sb.from("ghl_conversations").select("location_id").eq("owner_key", owner.toLowerCase()).limit(1);
  if (c?.[0]?.location_id) targets.push({ owner, biz: String(d["Business Name"] ?? "").trim(), loc: c[0].location_id });
  else targets.push({ owner, biz: String(d["Business Name"] ?? "").trim(), loc: null });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const t of targets) {
  if (!t.loc) { console.log(`NO-LOCATION | ${t.biz} (${t.owner})`); continue; }
  try {
    const r = await fetch("https://services.leadconnectorhq.com/oauth/locationToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Version: "2021-07-28", Authorization: `Bearer ${oauth.access_token}` },
      body: new URLSearchParams({ companyId: oauth.company_id ?? "jU225y7HB756kCAH7d0X", locationId: t.loc }),
    });
    const tok = (await r.json()).access_token;
    if (!tok) { console.log(`MINT-FAIL | ${t.biz}`); continue; }
    const wj = await (await fetch(`https://services.leadconnectorhq.com/workflows/?locationId=${t.loc}`, { headers: { Authorization: `Bearer ${tok}`, Version: "2021-07-28", Accept: "application/json" } })).json();
    const wfs = wj.workflows ?? [];
    const hit = wfs.filter((w) => /follow[\s-]?up[\s-]?nurture/i.test(w.name ?? ""));
    if (!hit.length) console.log(`MISSING   | ${t.biz} (${t.owner})`);
    else {
      const bad = hit.filter((w) => String(w.status).toLowerCase() !== "published");
      if (bad.length && bad.length === hit.length) console.log(`OFF/DRAFT | ${t.biz} (${t.owner}) — ${hit.map((w) => `"${w.name}" [${w.status}]`).join("; ")}`);
      else console.log(`OK        | ${t.biz} — ${hit.map((w) => `"${w.name}" [${w.status}]`).join("; ")}`);
    }
    await sleep(200);
  } catch (e) { console.log(`ERROR     | ${t.biz}: ${String(e).slice(0, 100)}`); }
}
