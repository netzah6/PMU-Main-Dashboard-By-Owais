import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
const env = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: oauth } = await sb.from("ghl_oauth").select("*").eq("id", 1).single();
const { data: clients } = await sb.from("clients_master").select("data").ilike("data->>Version", "%v3%");
const live = (clients ?? []).map((r) => r.data).filter((d) => String(d["col_1"] ?? "").trim().toLowerCase() === "live");
const out = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const d of live) {
  const owner = String(d["Owner Full Name"] ?? "").trim();
  const biz = String(d["Business Name"] ?? "").trim();
  const { data: c } = await sb.from("ghl_conversations").select("location_id").eq("owner_key", owner.toLowerCase()).limit(1);
  const loc = c?.[0]?.location_id;
  if (!loc) { out.push({ biz, owner, loc: null, wf: null, note: "no location" }); continue; }
  try {
    const r = await fetch("https://services.leadconnectorhq.com/oauth/locationToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Version: "2021-07-28", Authorization: `Bearer ${oauth.access_token}` },
      body: new URLSearchParams({ companyId: oauth.company_id ?? "jU225y7HB756kCAH7d0X", locationId: loc }),
    });
    const tok = (await r.json()).access_token;
    const wj = await (await fetch(`https://services.leadconnectorhq.com/workflows/?locationId=${loc}`, { headers: { Authorization: `Bearer ${tok}`, Version: "2021-07-28", Accept: "application/json" } })).json();
    const hit = (wj.workflows ?? []).filter((w) => /funnel\s*survey/i.test(w.name ?? ""));
    out.push({ biz, owner, loc, wf: hit.map((w) => ({ id: w.id, name: w.name, status: w.status })) });
  } catch (e) { out.push({ biz, owner, loc, wf: null, note: String(e).slice(0, 80) }); }
  await sleep(150);
}
writeFileSync("/private/tmp/claude-501/-Users-netzahmizrahi-Run-Claude-Code-Here/e722a9e0-59c7-49fc-a4e2-4330b895a49e/scratchpad/ccfs-workflows.json", JSON.stringify(out, null, 1));
console.log("total:", out.length);
console.log("no funnel-survey wf:", out.filter((o) => o.wf && o.wf.length === 0).map((o) => o.biz).join(", ") || "(none)");
console.log("multi:", out.filter((o) => o.wf && o.wf.length > 1).map((o) => `${o.biz}(${o.wf.length})`).join(", ") || "(none)");
