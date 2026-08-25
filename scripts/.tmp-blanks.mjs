import { readFileSync } from "node:fs";
const env={};for(const l of readFileSync(".env.local","utf8").split("\n")){const m=l.match(/^([A-Z0-9_]+)=(.*)$/);if(m)env[m[1]]=m[2].replace(/^"|"$/g,"")}
const SB=env.NEXT_PUBLIC_SUPABASE_URL,H={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`};
let rows=[],from=0;
while(true){const p=await fetch(`${SB}/rest/v1/deposits?select=sheet_row,external_id,data&order=sheet_row.asc.nullslast`,{headers:{...H,Range:`${from}-${from+999}`}}).then(r=>r.json());if(!Array.isArray(p)||!p.length)break;rows=rows.concat(p);if(p.length<1000)break;from+=1000;}
const isBlank=d=>!String(d?.['Email']||'').trim()&&!String(d?.['Full Name']||'').trim()&&!String(d?.['Business Name']||'').trim();
const blanks=rows.filter(r=>r.sheet_row!=null&&isBlank(r.data)).map(r=>r.sheet_row).sort((a,b)=>a-b);
console.log(`mirror rows: ${rows.length}; blank sheet rows: ${blanks.length}: [${blanks.join(',')}]`);
const ashley=rows.find(r=>/ashley keim/i.test(JSON.stringify(r.data||{})));
console.log(`Ashley Keim now at sheet_row ${ashley?.sheet_row} (was 918 pre-shift; +11 predicted = 929)`);
const maxRow=Math.max(...rows.filter(r=>r.sheet_row!=null).map(r=>r.sheet_row));
console.log(`max sheet_row: ${maxRow}`);
