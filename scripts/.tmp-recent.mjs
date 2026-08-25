import { readFileSync } from "node:fs";
const env={};for(const l of readFileSync(".env.local","utf8").split("\n")){const m=l.match(/^([A-Z0-9_]+)=(.*)$/);if(m)env[m[1]]=m[2].replace(/^"|"$/g,"")}
const SB=env.NEXT_PUBLIC_SUPABASE_URL,H={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`};
let rows=[],from=0;
while(true){const p=await fetch(`${SB}/rest/v1/deposits?select=sheet_row,external_id,synced_at,data`,{headers:{...H,Range:`${from}-${from+999}`}}).then(r=>r.json());if(!Array.isArray(p)||!p.length)break;rows=rows.concat(p);if(p.length<1000)break;from+=1000;}
const D=s=>{const m=String(s||'').match(/^(\d{2})\/(\d{2})\/(\d{4})/);if(m)return `${m[3]}-${m[2]}-${m[1]}`;return String(s||'').slice(0,10);};
const recent=rows.filter(r=>{const d=D(r.data?.Date);return d>="2026-08-19";});
console.log(`total rows: ${rows.length}; deposits dated Aug 19-20: ${recent.length}`);
for(const r of recent.sort((a,b)=>D(a.data?.Date).localeCompare(D(b.data?.Date))))
 console.log(`  ${D(r.data?.Date)}  sheet_row=${r.sheet_row??'null(webhook)'}  ${String(r.data?.['Full Name']||'?').slice(0,22).padEnd(22)} ${String(r.data?.['Business Name']||'?').slice(0,30)}`);
const maxRow=Math.max(...rows.filter(r=>r.sheet_row!=null).map(r=>r.sheet_row));
console.log(`max sheet_row: ${maxRow}`);
