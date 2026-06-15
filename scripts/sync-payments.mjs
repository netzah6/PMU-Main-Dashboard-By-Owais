// Populate client_payments from the latest month tab of the financing sheet
// (SHEET5_ID). Re-runnable. Mirrors src/lib/payments.ts for local/manual use.
//
// Usage: node scripts/sync-payments.mjs
import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const l of readFileSync(join(__dirname, "..", ".env.local"), "utf8").split("\n")) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const MONTHS = { jan:1,january:1,feb:2,february:2,mar:3,march:3,apr:4,april:4,may:5,jun:6,june:6,jul:7,july:7,aug:8,august:8,sep:9,sept:9,september:9,oct:10,october:10,nov:11,november:11,dec:12,december:12 };
const monthOf = (t) => MONTHS[t.trim().toLowerCase().split(/\s+/)[0]] ?? null;
function pickLatestMonthTab(tabs){let best=null;for(const t of tabs){const m=monthOf(t);if(m==null)continue;if(!best||m>=best.month)best={title:t,month:m};}return best?.title??null;}

export function normalizeOwnerKey(name){return String(name??"").toLowerCase().replace(/\([^)]*\)/g," ").replace(/[^a-z0-9]+/g," ").trim().replace(/\s+/g," ");}

const norm = (s) => String(s ?? "").trim().toLowerCase();
function mapColumns(rows){
  for(let i=0;i<Math.min(rows.length,12);i++){
    const row=rows[i].map(norm);
    const nameIdx=row.findIndex(c=>c==="client name");
    if(nameIdx===-1)continue;
    const find=(...labels)=>row.findIndex(c=>labels.some(l=>c===l||c.includes(l)));
    return {headerRow:i,name:nameIdx,usd:find("usd"),payStatus:find("payment status"),billStatus:find("billing status"),payDay:find("day of payment","day of renew"),notes:find("notes about their monthly plan","notes")};
  }
  return null;
}
function parseUsd(v){if(v==null||v==="")return null;const n=parseFloat(String(v).replace(/[$,]/g,""));return isNaN(n)?null:n;}
function isSkipRow(name){const n=name.toLowerCase();return !name||n.includes("total")||n.includes("deposits from clients")||n==="client name";}

async function main(){
  const spreadsheetId=env.SHEET5_ID;
  if(!spreadsheetId)throw new Error("SHEET5_ID not set");
  const auth=new google.auth.GoogleAuth({credentials:{client_email:env.GOOGLE_SERVICE_ACCOUNT_EMAIL,private_key:(env.GOOGLE_PRIVATE_KEY||"").replace(/\\n/g,"\n")},scopes:["https://www.googleapis.com/auth/spreadsheets.readonly"]});
  const sheets=google.sheets({version:"v4",auth});
  const meta=await sheets.spreadsheets.get({spreadsheetId,fields:"sheets.properties.title"});
  const tabs=(meta.data.sheets||[]).map(s=>s.properties?.title||"");
  const monthTab=pickLatestMonthTab(tabs);
  if(!monthTab)throw new Error("No month tab found");
  console.log("Latest month tab:",monthTab);

  const res=await sheets.spreadsheets.values.get({spreadsheetId,range:`'${monthTab}'!A1:H200`,valueRenderOption:"UNFORMATTED_VALUE"});
  const rows=res.data.values||[];
  const cols=mapColumns(rows);
  if(!cols)throw new Error("No header row found");

  const seen=new Set();const payments=[];
  for(let i=cols.headerRow+1;i<rows.length;i++){
    const row=rows[i]||[];
    const clientName=String(row[cols.name]??"").trim();
    if(isSkipRow(clientName))continue;
    const key=normalizeOwnerKey(clientName);
    if(!key||seen.has(key))continue;
    seen.add(key);
    payments.push({
      owner_key:key,client_name:clientName,
      usd:cols.usd>=0?parseUsd(row[cols.usd]):null,
      payment_status:cols.payStatus>=0?String(row[cols.payStatus]??"").trim():"",
      billing_status:cols.billStatus>=0?String(row[cols.billStatus]??"").trim():"",
      pay_day:cols.payDay>=0?String(row[cols.payDay]??"").trim():"",
      notes:cols.notes>=0?String(row[cols.notes]??"").trim():"",
      month:monthTab,updated_at:new Date().toISOString(),
    });
  }

  const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
  await sb.from("client_payments").delete().neq("owner_key","");
  if(payments.length){
    const {error}=await sb.from("client_payments").upsert(payments,{onConflict:"owner_key"});
    if(error)throw new Error(error.message);
  }
  console.log(`DONE — ${payments.length} client payments synced from "${monthTab}"`);
}
main().catch(e=>{console.error(e);process.exit(1);});
