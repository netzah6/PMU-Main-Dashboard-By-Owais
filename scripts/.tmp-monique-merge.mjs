// Merge the duplicate Monique Garcia rows in Clients Master:
// keep the "(V1)" row, copy the Launch Call date from the other, VOID the other.
// VOID recipe (2026-08-20 lesson): never delete a row, never leave it fully
// blank — clear the data but write VOID in column A so table detection stays
// contiguous.
import { google } from "googleapis";
import { readFileSync } from "node:fs";
const env = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const WRITE = process.argv.includes("--write");
const auth = new google.auth.JWT({ email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL, key: env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
const sheets = google.sheets({ version: "v4", auth });
const TAB = "Clients Master";
const res = await sheets.spreadsheets.values.get({ spreadsheetId: env.SHEET1_ID, range: `${TAB}!A1:BZ2000` });
const rows = res.data.values ?? [];
const header = rows[0].map((h) => String(h ?? "").trim());
const col = (name) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
const cOwner = col("Owner Full Name"), cVer = col("Version"), cLaunch = col("Launch Call");
if (cOwner < 0 || cVer < 0 || cLaunch < 0) throw new Error(`cols missing: owner=${cOwner} ver=${cVer} launch=${cLaunch}`);

const moniques = [];
rows.forEach((r, i) => {
  if (i > 0 && String(r[cOwner] ?? "").trim().toLowerCase() === "monique garcia") moniques.push(i + 1); // 1-based A1 row
});
console.log("Monique rows (A1):", moniques.join(", "));
if (moniques.length !== 2) throw new Error("expected exactly 2 Monique rows — aborting");

const [a, b] = moniques;
const ver = (r) => String(rows[r - 1][cVer] ?? "").trim();
const keep = ver(a) === "(V1)" ? a : ver(b) === "(V1)" ? b : null;
const kill = keep === a ? b : a;
if (!keep) throw new Error(`neither row has Version (V1): "${ver(a)}" / "${ver(b)}" — aborting`);
console.log(`KEEP row ${keep} (Version "${ver(keep)}"), VOID row ${kill} (Version "${ver(kill)}")`);

const launchDate = String(rows[kill - 1][cLaunch] ?? "").trim();
const keepLaunch = String(rows[keep - 1][cLaunch] ?? "").trim();
console.log(`Launch Call: keep-row has "${keepLaunch}", void-row has "${launchDate}"`);

const colLetter = (i) => { let s = ""; for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s; return s; };
const width = rows[kill - 1].length;
const updates = [];
if (/^\d{2}\/\d{2}\/\d{4}$/.test(launchDate) && !/^\d{2}\/\d{2}\/\d{4}$/.test(keepLaunch)) {
  updates.push({ range: `${TAB}!${colLetter(cLaunch)}${keep}`, values: [[launchDate]] });
}
updates.push({ range: `${TAB}!A${kill}:${colLetter(Math.max(width, header.length) - 1)}${kill}`, values: [["VOID", ...Array(Math.max(width, header.length) - 1).fill("")]] });

for (const u of updates) console.log(`${WRITE ? "WRITE" : "DRY"}  ${u.range}  ->  ${JSON.stringify(u.values[0].slice(0, 3))}…`);
if (WRITE) {
  await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: env.SHEET1_ID, requestBody: { valueInputOption: "RAW", data: updates } });
  console.log("DONE — wrote", updates.length, "range(s). Voided sheet row:", kill);
}
