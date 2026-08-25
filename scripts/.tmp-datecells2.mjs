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
const get = async (range, render) => {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await sheets.spreadsheets.values.get({ spreadsheetId: ID, range, valueRenderOption: render });
      return r.data.values ?? [];
    } catch (e) { console.log("retry", range, String(e).slice(0, 60)); await sleep(3000 * (a + 1)); }
  }
  throw new Error("gave up " + range);
};
const header = (await get("Deposits!A1:H1", "UNFORMATTED_VALUE"))[0];
console.log("header:", JSON.stringify(header));
await sleep(1500);
const rows = await get("Deposits!A850:H1000", "UNFORMATTED_VALUE");
const dateCol = header.findIndex((h) => /^date$/i.test(String(h).trim()));
console.log("date col:", dateCol);
rows.forEach((r, i) => {
  const v = r?.[dateCol];
  if (typeof v === "number" && v > 40000 && v < 50000) {
    console.log("SERIAL row", 850 + i, "value", v, "| name:", r?.[1] ?? "", "|", r?.[2] ?? "");
  }
});
console.log("last row scanned:", 850 + rows.length - 1);
