import { google } from "googleapis";
import { readFileSync } from "node:fs";
const env = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const auth = new google.auth.JWT({ email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL, key: env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
const sheets = google.sheets({ version: "v4", auth });
const ID = env.SHEET_DATA_ID;
const [unf, fmt] = await Promise.all([
  sheets.spreadsheets.values.get({ spreadsheetId: ID, range: "Deposits!A1:H1000", valueRenderOption: "UNFORMATTED_VALUE" }),
  sheets.spreadsheets.values.get({ spreadsheetId: ID, range: "Deposits!A1:H1000", valueRenderOption: "FORMATTED_VALUE" }),
]);
const u = unf.data.values ?? [], f = fmt.data.values ?? [];
console.log("header:", JSON.stringify(u[0]));
// find Date column
const dateCol = u[0].findIndex((h) => /^date$/i.test(String(h).trim()));
console.log("date col idx:", dateCol, "| total rows:", u.length);
let firstSerial = null, serialRows = [];
for (let i = 1; i < u.length; i++) {
  const v = u[i]?.[dateCol];
  if (typeof v === "number" && v > 40000 && v < 50000) {
    if (firstSerial === null) firstSerial = i + 1;
    serialRows.push({ row: i + 1, raw: v, formatted: f[i]?.[dateCol], name: u[i]?.[2] ?? u[i]?.[1] });
  }
}
console.log("serial-date rows:", serialRows.length, "| first at sheet row", firstSerial);
console.log(JSON.stringify(serialRows.slice(0, 12), null, 1));
// context: the last 3 text rows before the first serial row
if (firstSerial) {
  for (let i = Math.max(1, firstSerial - 4); i < firstSerial; i++) {
    console.log("before:", i + 1, JSON.stringify(u[i]?.[dateCol]), "fmt:", JSON.stringify(f[i]?.[dateCol]));
  }
}
