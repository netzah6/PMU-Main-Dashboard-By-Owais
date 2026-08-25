import { google } from "googleapis";
import { readFileSync } from "node:fs";
const env = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const auth = new google.auth.JWT({ email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL, key: env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"), scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
const sheets = google.sheets({ version: "v4", auth });
const ID = env.SHEET4_ID;
try {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: ID, fields: "properties(title),sheets(properties(title))" });
  console.log("TITLE:", meta.data.properties.title);
  console.log("TABS:", meta.data.sheets.map((s) => s.properties.title).join(" | "));
} catch (e) { console.log("META ERROR:", String(e).slice(0, 200)); }

try {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: env.SHEET4_ID, range: "7 Days CPL!A1:C3", valueRenderOption: "UNFORMATTED_VALUE" });
  console.log("7DAYS SAMPLE:", JSON.stringify(r.data.values));
} catch (e) { console.log("VALUES ERROR:", String(e).slice(0, 250)); }
