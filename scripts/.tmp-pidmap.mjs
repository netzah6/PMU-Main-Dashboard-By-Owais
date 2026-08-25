import { readFileSync, writeFileSync } from "node:fs";
const env={};for(const l of readFileSync(".env.local","utf8").split("\n")){const m=l.match(/^([A-Z0-9_]+)=(.*)$/);if(m)env[m[1]]=m[2].replace(/^"|"$/g,"")}
const SB=env.NEXT_PUBLIC_SUPABASE_URL,H={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`};
let rows=[],from=0;
while(true){const p=await fetch(`${SB}/rest/v1/deposits?select=data`,{headers:{...H,Range:`${from}-${from+999}`}}).then(r=>r.json());if(!Array.isArray(p)||!p.length)break;rows=rows.concat(p);if(p.length<1000)break;from+=1000;}
const votes=new Map();
for(const r of rows){const pid=String(r.data?.["Product ID"]||"").trim();const biz=String(r.data?.["Business Name"]||"").trim();
 if(!pid||!biz)continue;if(!votes.has(pid))votes.set(pid,new Map());const m=votes.get(pid);m.set(biz,(m.get(biz)||0)+1);}
const map={},amb=[];
for(const [pid,m] of votes){const sorted=[...m.entries()].sort((a,b)=>b[1]-a[1]);map[pid]=sorted[0][0];
 if(sorted.length>1)amb.push(`${pid}: ${sorted.map(([b,n])=>`${b}(${n})`).join(" vs ")}`);}
writeFileSync("/tmp/pidmap.json",JSON.stringify(map));
console.log(`product ids: ${Object.keys(map).length}; ambiguous (multi-business):`);amb.forEach(a=>console.log("  "+a));
