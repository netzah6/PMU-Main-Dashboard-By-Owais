import { google } from "googleapis";
import { readFileSync } from "node:fs";
const env={};for(const l of readFileSync(".env.local","utf8").split("\n")){const m=l.match(/^([A-Z0-9_]+)=(.*)$/);if(m)env[m[1]]=m[2].replace(/^"|"$/g,"")}
const BLANKS=[72,134,140,186,206,223,238,255,263,265,275,283,292,303,323,346,356,362,368,469,484,617,627,635,659,675,679,683,685,709,710,711,794,797,818];
const auth=new google.auth.JWT({email:env.GOOGLE_SERVICE_ACCOUNT_EMAIL,key:env.GOOGLE_PRIVATE_KEY.replace(/\\n/g,"\n"),scopes:["https://www.googleapis.com/auth/spreadsheets"]});
const sheets=google.sheets({version:"v4",auth});
async function retry(fn,tries=8){let last;for(let i=0;i<tries;i++){try{return await fn();}catch(e){last=e;console.log(`  retry ${i+1}: ${String(e.message||e).slice(0,45)}`);await new Promise(r=>setTimeout(r,6000));}}throw last;}
// 1. VOID marker in column A of every blank row — makes the table contiguous
const data=BLANKS.map(n=>({range:`Deposits!A${n}`,values:[["VOID"]]}));
await retry(()=>sheets.spreadsheets.values.batchUpdate({spreadsheetId:env.SHEET_DATA_ID,requestBody:{valueInputOption:"RAW",data}}));
console.log("35 blank rows marked VOID ✓");
// 2. append-test: where does Sheets place a new row now?
const t=await retry(()=>sheets.spreadsheets.values.append({spreadsheetId:env.SHEET_DATA_ID,range:"Deposits!A1:G1",valueInputOption:"RAW",insertDataOption:"INSERT_ROWS",requestBody:{values:[["VOID"]]}}));
console.log("append-test landed at:",t.data.updates?.updatedRange);
