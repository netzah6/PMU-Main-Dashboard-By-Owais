import { google } from "googleapis";
import { readFileSync } from "node:fs";
const env = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const auth = new google.auth.JWT({ email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL, key: env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"), scopes: ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/spreadsheets.readonly"] });
const drive = google.drive({ version: "v3", auth });
const f = await drive.files.get({ fileId: env.SHEET4_ID, fields: "modifiedTime,name" });
console.log("file:", f.data.name, "| last modified (UTC):", f.data.modifiedTime);
const sheets = google.sheets({ version: "v4", auth });
const r = await sheets.spreadsheets.values.get({ spreadsheetId: env.SHEET4_ID, range: "7 Days CPL!A1:A1" });
console.log("banner:", JSON.stringify(r.data.values?.[0]?.[0] ?? ""));
console.log("now UTC:", new Date().toISOString());
