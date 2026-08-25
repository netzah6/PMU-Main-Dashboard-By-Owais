// Finish the repair: lock column A to TEXT format + verify no serials remain.
import { google } from "googleapis";
import { readFileSync } from "node:fs";
const env = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const auth = new google.auth.JWT({ email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL, key: env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
const sheets = google.sheets({ version: "v4", auth });
const ID = env.SHEET_DATA_ID;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withRetry = async (fn, label, tries = 20) => {
  for (let a = 0; a < tries; a++) {
    try { return await fn(); }
    catch (e) { console.log(`retry ${label} (${a + 1})`); await sleep(15000); }
  }
  throw new Error("gave up: " + label);
};
const meta = await withRetry(() => sheets.spreadsheets.get({ spreadsheetId: ID, fields: "sheets(properties(sheetId,title))" }), "meta");
const dep = meta.data.sheets.find((s) => s.properties.title === "Deposits");
await withRetry(() => sheets.spreadsheets.batchUpdate({
  spreadsheetId: ID,
  requestBody: { requests: [{ repeatCell: {
    range: { sheetId: dep.properties.sheetId, startColumnIndex: 0, endColumnIndex: 1, startRowIndex: 1 },
    cell: { userEnteredFormat: { numberFormat: { type: "TEXT", pattern: "@" } } },
    fields: "userEnteredFormat.numberFormat",
  } }] },
}), "format");
console.log("column A locked to TEXT");
const check = await withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: ID, range: "Deposits!A1:A1200", valueRenderOption: "UNFORMATTED_VALUE" }).then((r) => r.data.values ?? []), "verify");
const remaining = check.filter((r) => typeof r?.[0] === "number" && r[0] > 40000 && r[0] < 50000).length;
const textDates = check.filter((r) => /^\d{2}\/\d{2}\/\d{4}$/.test(String(r?.[0] ?? ""))).length;
console.log(`verify: remaining serials = ${remaining}, text dates = ${textDates}`);
console.log("REPAIR COMPLETE");
