// Reads the "Private Integrations - GHL" sheet (GHL_KEYS_SHEET_ID), pulls each
// V3 client's "CC - Offer" custom value from their GHL sub-account, stores it in
// client_offers keyed by the V3 canonical OWNER/BUSINESS name (so the
// deposit_overview join lines up). V3 only. Keys read transiently — never stored.
import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const l of readFileSync(join(__dirname, "..", ".env.local"), "utf8").split("\n")) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const nameTokens = (s) => new Set(String(s ?? "").toLowerCase().replace(/[^a-z]+/g, " ").split(" ").filter((t) => t.length >= 2));
const sameClient = (a, b) => { let s = 0; for (const t of a) if (b.has(t)) s++; return s >= 2 || (s >= 1 && (a.size === 1 || b.size === 1)); };
const auth = new google.auth.GoogleAuth({ credentials: { client_email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL, private_key: (env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n") }, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
const sheets = google.sheets({ version: "v4", auth });
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: v3Rows } = await sb.from("v3_pricing").select("data");
const v3List = (v3Rows ?? []).map((r) => String(r.data?.["OWNER/BUSINESS"] ?? "").trim()).filter(Boolean).map((name) => ({ key: name.toLowerCase(), tokens: nameTokens(name) }));
const matchV3 = (t) => v3List.find((v) => sameClient(t, v.tokens))?.key ?? null;

const res = await sheets.spreadsheets.values.get({ spreadsheetId: env.GHL_KEYS_SHEET_ID, range: "Sheet1" });
const rows = res.data.values || [];
const header = rows[0].map((h) => String(h ?? "").toLowerCase());
const nameIdx = header.findIndex((h) => /^name/.test(h.trim()));
const locIdx = header.findIndex((h) => /location/.test(h));
const tokIdx = header.findIndex((h) => /integration|private|key|token/.test(h));
let ok = 0, skipped = 0, failed = 0;
const kept = [];
for (const row of rows.slice(1)) {
  const name = String(row[nameIdx] ?? "").trim();
  const locationId = String(row[locIdx] ?? "").trim();
  const token = String(row[tokIdx] ?? "").trim();
  if (!name || !locationId || !token) { skipped++; continue; }
  const ownerKey = matchV3(nameTokens(name));
  if (!ownerKey) { skipped++; continue; }
  try {
    const r = await fetch(`https://services.leadconnectorhq.com/locations/${locationId}/customValues`, { headers: { Authorization: `Bearer ${token}`, Version: "2021-07-28", Accept: "application/json" } });
    if (!r.ok) { failed++; console.log("  fetch fail", ownerKey, r.status); continue; }
    const j = await r.json();
    const cvs = j.customValues || [];
    const cv = (needle) => { const hit = cvs.find((v) => String(v.name ?? "").toLowerCase().replace(/[^a-z]/g, "").includes(needle)); return hit ? String(hit.value ?? "") : ""; };
    const offer = cv("ccoffer");
    const depositAmount = cv("ccdepositamount");
    const originalPrice = cv("ccoriginalprice");
    const discountedPrice = cv("ccdiscountedprice");
    await sb.from("client_offers").upsert({ owner_key: ownerKey, offer, deposit_amount: depositAmount, original_price: originalPrice || null, discounted_price: discountedPrice || null, updated_at: new Date().toISOString() }, { onConflict: "owner_key" });
    kept.push(ownerKey); ok++; console.log("  OK", ownerKey, "| orig", originalPrice || "—", "| disc", discountedPrice || "—", "| dep", depositAmount || "—");
  } catch (e) { failed++; console.log("  ERR", ownerKey, String(e)); }
}
const { data: existing } = await sb.from("client_offers").select("owner_key");
const stale = (existing ?? []).map((e) => e.owner_key).filter((k) => !kept.includes(k));
if (stale.length) { await sb.from("client_offers").delete().in("owner_key", stale); console.log(`  pruned ${stale.length} stale rows`); }
console.log(`DONE — ok:${ok} skipped:${skipped} failed:${failed}`);
