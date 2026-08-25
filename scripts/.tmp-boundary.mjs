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
const get = async (range) => {
  for (let a = 0; a < 5; a++) {
    try { return (await sheets.spreadsheets.values.get({ spreadsheetId: ID, range, valueRenderOption: "UNFORMATTED_VALUE" })).data.values ?? []; }
    catch (e) { await sleep(4000 * (a + 1)); }
  }
  throw new Error("gave up " + range);
};
let firstSerial = null, lastText = null, serialCount = 0;
for (const [s, e] of [[2, 300], [300, 600], [600, 850]]) {
  const rows = await get(`Deposits!A${s}:A${e}`);
  rows.forEach((r, i) => {
    const v = r?.[0];
    if (typeof v === "number" && v > 40000 && v < 50000) { serialCount++; if (firstSerial === null) firstSerial = s + i; }
    else if (typeof v === "string" && v.trim()) lastText = s + i;
  });
  await sleep(2000);
}
console.log("rows 2-849: serials:", serialCount, "| first serial row:", firstSerial, "| last text row:", lastText);
