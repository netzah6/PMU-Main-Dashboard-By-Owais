// Sync a one-box client's GHL custom values into onebox_clients.config.
// Usage: node scripts/sync-onebox.mjs <slug> <locationId> [clientName]
// Reads env from .env.local; READ-ONLY against GHL. Extras (faqs,
// fanbasisHtml, elfsightId, resultImgs) are per-row and never overwritten.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const l of readFileSync(join(__dirname, "..", ".env.local"), "utf8").split("\n")) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const [slug, locationId, clientName = ""] = process.argv.slice(2);
if (!slug || !locationId) {
  console.error("usage: node scripts/sync-onebox.mjs <slug> <locationId> [clientName]");
  process.exit(1);
}

const SB = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const sbHeaders = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function tokenRequest(body) {
  const r = await fetch("https://services.leadconnectorhq.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: env.GHL_APP_CLIENT_ID,
      client_secret: env.GHL_APP_CLIENT_SECRET,
      ...body,
    }).toString(),
  });
  if (!r.ok) throw new Error(`oauth/token ${r.status}`);
  return r.json();
}

const rows = await fetch(`${SB}/rest/v1/ghl_oauth?id=eq.1&select=*`, { headers: sbHeaders }).then((r) => r.json());
const row = rows[0];
let token = row.access_token, companyId = row.company_id;
if (new Date(row.expires_at).getTime() <= Date.now()) {
  const j = await tokenRequest({ grant_type: "refresh_token", refresh_token: row.refresh_token, user_type: "Company" });
  token = j.access_token; companyId = j.companyId ?? companyId;
}
const lr = await fetch("https://services.leadconnectorhq.com/oauth/locationToken", {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    Version: "2021-07-28",
  },
  body: new URLSearchParams({ companyId, locationId }).toString(),
});
if (!lr.ok) throw new Error(`locationToken ${lr.status}`);
const locTok = (await lr.json()).access_token;

const cvr = await fetch(`https://services.leadconnectorhq.com/locations/${locationId}/customValues`, {
  headers: { Authorization: `Bearer ${locTok}`, Version: "2021-07-28", Accept: "application/json" },
});
if (!cvr.ok) throw new Error(`customValues ${cvr.status}`);
const { customValues } = await cvr.json();
const byName = {};
for (const v of customValues ?? []) byName[v.name] = String(v.value ?? "").trim();
const pick = (...names) => {
  for (const n of names) if (byName[n]) return byName[n];
  return "";
};

const config = {
  biz: pick("Business Name"),
  phone: pick("CC - Business Phone Number"),
  address: pick("CC - Full Business Address"),
  offer: pick("CC - Offer"),
  deposit: pick("CC - Deposit Amount 🔵", "CC - Deposit Amount") || "$50",
  logo: pick("CC - Funnel Logo"),
  igLink: pick("CC - IG Business Page Link"),
  calendarId: pick("CC - Permanent Makeup Transformation Calendar ID🔵"),
};

// Existing row: update config only — never clobber client_name
// (it once renamed every card to the account's "Business Name").
const existing = await fetch(`${SB}/rest/v1/onebox_clients?slug=eq.${encodeURIComponent(slug)}&select=slug`, { headers: sbHeaders }).then((r) => r.json());
const payload = existing.length
  ? { config, cv_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() }
  : {
      slug,
      location_id: locationId,
      client_name: clientName || config.biz,
      config,
      cv_synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
const up = existing.length
  ? await fetch(`${SB}/rest/v1/onebox_clients?slug=eq.${encodeURIComponent(slug)}`, {
      method: "PATCH",
      headers: sbHeaders,
      body: JSON.stringify(payload),
    })
  : await fetch(`${SB}/rest/v1/onebox_clients`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "return=representation" },
      body: JSON.stringify([payload]),
    });
if (!up.ok) throw new Error(`supabase upsert ${up.status}: ${await up.text()}`);
console.log(`synced ${slug} (${locationId}):`, config);
