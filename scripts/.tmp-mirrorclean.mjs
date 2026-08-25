import { readFileSync } from "node:fs";
const env={};for(const l of readFileSync(".env.local","utf8").split("\n")){const m=l.match(/^([A-Z0-9_]+)=(.*)$/);if(m)env[m[1]]=m[2].replace(/^"|"$/g,"")}
const SB=env.NEXT_PUBLIC_SUPABASE_URL,H={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`};
let rows=[],from=0;
while(true){const p=await fetch(`${SB}/rest/v1/deposits?select=id,sheet_row,external_id,data`,{headers:{...H,Range:`${from}-${from+999}`}}).then(r=>r.json());if(!Array.isArray(p)||!p.length)break;rows=rows.concat(p);if(p.length<1000)break;from+=1000;}
const isJunk=r=>{const d=r.data||{};return !r.external_id&&!String(d['Email']||'').trim()&&!String(d['Full Name']||'').trim()&&!String(d['Business Name']||'').trim();};
const junk=rows.filter(isJunk);
console.log(`empty junk rows in mirror: ${junk.length} at sheet_rows [${junk.map(r=>r.sheet_row).sort((a,b)=>a-b).join(',')}]`);
if(junk.length>40){console.log('unexpected count — abort');process.exit(1);}
let ok=0,fail=0;
for(const r of junk){const resp=await fetch(`${SB}/rest/v1/deposits?id=eq.${r.id}`,{method:'DELETE',headers:{...H,Prefer:'return=minimal'}});resp.ok?ok++:fail++;}
console.log(`deleted ${ok}, failed ${fail}`);
let n2=0,f2=0;
while(true){const p=await fetch(`${SB}/rest/v1/deposits?select=id`,{headers:{...H,Range:`${f2}-${f2+999}`}}).then(r=>r.json());if(!Array.isArray(p)||!p.length)break;n2+=p.length;if(p.length<1000)break;f2+=1000;}
console.log(`mirror rows now: ${n2}`);
