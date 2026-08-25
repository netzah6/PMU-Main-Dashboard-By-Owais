// Repair the Deposits sheet Date column:
// 1) rewrite every day-number (serial) cell as its dd/mm/yyyy TEXT equivalent
// 2) force the whole column to plain-text format so future writes stay text
// Values only change representation (46255 -> "21/08/2026"), never the date itself.
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
const withRetry = async (fn, label) => {
  for (let a = 0; a < 8; a++) {
    try { return await fn(); }
    catch (e) { console.log(`retry ${label}: ${String(e).slice(0, 70)}`); await sleep(5000 * (a + 1)); }
  }
  throw new Error("gave up: " + label);
};
const toDate = (serial) => {
  const d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
};
// sanity anchor: 46255 must be 21/08/2026
if (toDate(46255) !== "21/08/2026") throw new Error("serial conversion sanity check failed: " + toDate(46255));

// 1. scan the whole column
const col = await withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: ID, range: "Deposits!A1:A1200", valueRenderOption: "UNFORMATTED_VALUE" }).then((r) => r.data.values ?? []), "scan");
const fixes = [];
col.forEach((r, i) => {
  const v = r?.[0];
  if (typeof v === "number" && v > 40000 && v < 50000) fixes.push({ row: i + 1, serial: v, text: toDate(v) });
});
console.log(`serial cells found: ${fixes.length} (rows ${fixes[0]?.row}-${fixes[fixes.length - 1]?.row})`);
if (fixes.length) {
  // 2. rewrite as text, chunked
  for (let i = 0; i < fixes.length; i += 100) {
    const chunk = fixes.slice(i, i + 100);
    await withRetry(() => sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: ID,
      requestBody: { valueInputOption: "RAW", data: chunk.map((f) => ({ range: `Deposits!A${f.row}`, values: [[f.text]] })) },
    }), `write ${i}`);
    console.log(`wrote ${Math.min(i + 100, fixes.length)}/${fixes.length}`);
    await sleep(1500);
  }
}
// 3. force column A to TEXT format (needs the sheet's numeric id)
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
console.log("column A formatted as TEXT");
// 4. verify
const check = await withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: ID, range: "Deposits!A1:A1200", valueRenderOption: "UNFORMATTED_VALUE" }).then((r) => r.data.values ?? []), "verify");
const remaining = check.filter((r) => typeof r?.[0] === "number" && r[0] > 40000 && r[0] < 50000).length;
console.log(`verify: remaining serial cells = ${remaining}`);
console.log("REPAIR COMPLETE");
