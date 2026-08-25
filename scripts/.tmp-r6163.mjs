import { readFileSync } from "node:fs";
const env={};for(const l of readFileSync(".env.local","utf8").split("\n")){const m=l.match(/^([A-Z0-9_]+)=(.*)$/);if(m)env[m[1]]=m[2].replace(/^"|"$/g,"")}
const SB=env.NEXT_PUBLIC_SUPABASE_URL,H={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`};
const rows=await fetch(`${SB}/rest/v1/deposits?sheet_row=gte.61&sheet_row=lte.75&select=sheet_row,synced_at,data&order=sheet_row`,{headers:H}).then(r=>r.json());
for(const r of rows)console.log(`row ${r.sheet_row}: ${String(r.data?.['Full Name']||'(empty)').slice(0,22).padEnd(22)} | ${String(r.data?.['Business Name']||'').slice(0,26).padEnd(26)} | ${String(r.data?.Date||'').slice(0,10)} | synced ${String(r.synced_at||'').slice(5,16)}`);
