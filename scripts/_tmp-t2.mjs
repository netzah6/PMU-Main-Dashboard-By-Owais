import { google } from "googleapis";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const l of readFileSync(join(__dirname, "..", ".env.local"), "utf8").split("\n")) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const auth = new google.auth.GoogleAuth({credentials:{client_email:env.GOOGLE_SERVICE_ACCOUNT_EMAIL,private_key:(env.GOOGLE_PRIVATE_KEY||"").replace(/\\n/g,"\n")},scopes:["https://www.googleapis.com/auth/spreadsheets.readonly"]});
const sheets = google.sheets({ version: "v4", auth });
let t=Date.now();
const res = await sheets.spreadsheets.values.get({ spreadsheetId: env.SHEET_DATA_ID, range: `'Deposits'!A1:Z1200`, valueRenderOption:"UNFORMATTED_VALUE", dateTimeRenderOption:"FORMATTED_STRING" });
const rows = res.data.values ?? [];
console.log("bounded read:", Date.now()-t,"ms | rows:",rows.length,"cols:",(rows[0]||[]).length);
console.log("HEADERS:", JSON.stringify(rows[0]));
const hits = rows.map((r,i)=>[i+1,r]).filter(([i,r])=>/bowser/i.test(JSON.stringify(r)));
for (const [i,r] of hits) console.log("GRACE ROW",i,JSON.stringify(r));
console.log("LAST ROW #", rows.length, JSON.stringify(rows[rows.length-1]));
process.exit(0);
