// Repair Ad Account Name values in Clients Master that don't match the name the
// CPL sheet uses. A mismatch blanks out CPL entirely in performance_overview,
// because that view joins on the ad account name.
//
// Only rewrites a cell when its CURRENT value is exactly the expected wrong one,
// so a re-run is a no-op and an unexpected value is reported instead of clobbered.
//
// Usage: node scripts/fix-ad-account-names.mjs [--write]   (default = dry run)
import { google } from "googleapis";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(join(__dirname, "..", ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const WRITE = process.argv.includes("--write");
const TAB = "Clients Master";

// businessName -> { from: current wrong value, to: name used by the CPL sheet }
const FIXES = [
  // Christy Ray's row is titled "CC Styling N." in Business Name too — the CPL
  // sheet knows her account as "CC Styling Studio". Only the ad account name is
  // corrected here; the business name is left as the team wrote it.
  { business: "CC Styling N.",                       from: "CC Styling N.",             to: "CC Styling Studio" },
  { business: "VY Tatlock Beauty Studio",            from: "Vy Tatlock Studio",         to: "VY Tatlock Beauty Studio" },
  { business: "Nu You Spa By Vicky Le - ad account", from: "Nu You Spa By Vicky Le",     to: "Nu You Spa By Vicky Le - ad account" },
  { business: "Beauty Ink by Carmen LLC",            from: "Beauty Ink by Carmen, LLC",  to: "Beauty Ink by Carmen LLC" },
];

const auth = new google.auth.JWT({
  email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

const res = await sheets.spreadsheets.values.get({
  spreadsheetId: env.SHEET1_ID,
  range: `${TAB}!A1:BZ2000`,
});
const rows = res.data.values ?? [];
if (!rows.length) throw new Error("Clients Master came back empty");

const header = rows[0].map((h) => String(h ?? "").trim());
const colAcct = header.findIndex((h) => /^ad account name$/i.test(h));
const colBiz = header.findIndex((h) => /^business name$/i.test(h));
if (colAcct < 0 || colBiz < 0) throw new Error(`Columns not found. Header: ${header.join(" | ")}`);

const colLetter = (i) => {
  let s = "";
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
  return s;
};

const updates = [];
for (const fix of FIXES) {
  const norm = (s) => String(s ?? "").trim().toLowerCase();
  const idx = rows.findIndex((r, i) => i > 0 && norm(r[colBiz]) === norm(fix.business));
  if (idx < 0) { console.log(`SKIP  ${fix.business} — no row with that Business Name`); continue; }
  const current = String(rows[idx][colAcct] ?? "").trim();
  if (current === fix.to) { console.log(`OK    ${fix.business} — already "${fix.to}"`); continue; }
  if (current !== fix.from) {
    console.log(`SKIP  ${fix.business} — expected "${fix.from}" but found "${current}"; not touching it`);
    continue;
  }
  const a1 = `${TAB}!${colLetter(colAcct)}${idx + 1}`;
  console.log(`FIX   ${a1}  "${current}"  ->  "${fix.to}"   (${fix.business})`);
  updates.push({ range: a1, values: [[fix.to]] });
}

if (!updates.length) { console.log("\nNothing to write."); process.exit(0); }
if (!WRITE) { console.log(`\nDRY RUN — ${updates.length} cell(s) would change. Re-run with --write.`); process.exit(0); }

await sheets.spreadsheets.values.batchUpdate({
  spreadsheetId: env.SHEET1_ID,
  requestBody: { valueInputOption: "RAW", data: updates },
});
console.log(`\nWROTE ${updates.length} cell(s).`);
