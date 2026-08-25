import { google } from "googleapis";
import { readFileSync } from "node:fs";
const env={};for(const l of readFileSync(".env.local","utf8").split("\n")){const m=l.match(/^([A-Z0-9_]+)=(.*)$/);if(m)env[m[1]]=m[2].replace(/^"|"$/g,"")}
const auth=new google.auth.JWT({email:env.GOOGLE_SERVICE_ACCOUNT_EMAIL,key:env.GOOGLE_PRIVATE_KEY.replace(/\\n/g,"\n"),scopes:["https://www.googleapis.com/auth/spreadsheets"]});
const sheets=google.sheets({version:"v4",auth});
for(let i=0;i<8;i++){
 try{const r=await sheets.spreadsheets.values.get({spreadsheetId:env.SHEET_DATA_ID,range:"Deposits!A1:J1"});
  console.log("HEADER:",JSON.stringify(r.data.values?.[0]));process.exit(0);}
 catch(e){console.log(`try ${i+1}:`,String(e.message||e).slice(0,40));await new Promise(r=>setTimeout(r,6000));}
}
console.log("READS DEAD");
