// List GHL users (id, name, email) for the PMU Bookings On Demand tasks account
import { google } from "googleapis";
import { readFileSync } from "node:fs";
const env = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const auth = new google.auth.JWT({ email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL, key: env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"), scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
const sheets = google.sheets({ version: "v4", auth });
const res = await sheets.spreadsheets.values.get({ spreadsheetId: env.GHL_KEYS_SHEET_ID, range: "Sheet1" });
const rows = res.data.values ?? [];
const header = rows[0].map((h) => String(h ?? "").toLowerCase());
const nameIdx = header.findIndex((h) => /^name/.test(h.trim()));
const bizIdx = header.findIndex((h) => /business/.test(h));
const locIdx = header.findIndex((h) => /location/.test(h));
const tokIdx = header.findIndex((h) => /integration|private|key|token/.test(h));
let acct = null;
for (const r of rows.slice(1)) {
  const hay = `${r[nameIdx] ?? ""} ${bizIdx >= 0 ? r[bizIdx] ?? "" : ""}`.toLowerCase();
  if (hay.includes("bookings on demand") || hay.includes("pmu bookings")) {
    const locationId = String(r[locIdx] ?? "").trim(); const token = String(r[tokIdx] ?? "").trim();
    if (locationId && token) { acct = { locationId, token }; break; }
  }
}
if (!acct) { console.log("no account"); process.exit(1); }
const ur = await fetch(`https://services.leadconnectorhq.com/users/?locationId=${acct.locationId}`, { headers: { Authorization: `Bearer ${acct.token}`, Version: "2021-07-28", Accept: "application/json" } });
console.log("HTTP", ur.status); const uj = await ur.json(); if (!uj.users) console.log("RAW:", JSON.stringify(uj).slice(0,400));
for (const u of uj.users ?? []) console.log(JSON.stringify({ id: u.id, name: u.name, email: u.email }));
