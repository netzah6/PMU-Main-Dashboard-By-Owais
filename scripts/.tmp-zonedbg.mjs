import { readFileSync } from "node:fs";
const env={};
for(const f of ["/tmp/venv.env",".env.local"])
 for(const l of readFileSync(f,"utf8").split("\n")){const m=l.match(/^([A-Z0-9_]+)="?([^"]*)"?/);if(m&&!(m[1] in env))env[m[1]]=m[2];}
const token=env.MAKE_API_TOKEN;
for(const zone of ["us1","us2","eu1","eu2"]){
 const mk=async p=>{const r=await fetch(`https://${zone}.make.com/api/v2${p}`,{headers:{Authorization:`Token ${token}`,Accept:"application/json"}});return{ok:r.ok,status:r.status,json:await r.json().catch(()=>({}))};};
 const o=await mk("/organizations");
 const ol=o.json.organizations??[];
 console.log(`${zone}: orgs HTTP ${o.status}, ${ol.length} orgs`);
 for(const org of ol){
  const t=await mk(`/teams?organizationId=${org.id}`);
  const tl=t.json.teams??[];
  console.log(`  org ${org.id} "${org.name}": ${tl.length} teams`);
  for(const tm of tl){
   const s=await mk(`/scenarios?teamId=${tm.id}`);
   const names=(s.json.scenarios??[]).map(x=>x.name);
   console.log(`    team ${tm.id} "${tm.name}": ${names.length} scenarios: ${JSON.stringify(names.slice(0,10))}`);
  }
 }
}
