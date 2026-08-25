import { readFileSync } from "node:fs";
const env={};
for(const f of ["/tmp/venv.env", ".env.local"])
 for(const l of readFileSync(f,"utf8").split("\n")){const m=l.match(/^([A-Z0-9_]+)="?([^"]*)"?/);if(m&&!(m[1] in env))env[m[1]]=m[2];}
const token=env.MAKE_API_TOKEN;
console.log("token:",token?"yes":"MISSING","| zone:",env.MAKE_ZONE||"(scan)","| pin:",env.MAKE_SCENARIO_ID||"(none)");
const zones=env.MAKE_ZONE?[env.MAKE_ZONE]:["us1","us2","eu1","eu2"];
let zone=zones[0];
const mk=async p=>{const r=await fetch(`https://${zone}.make.com/api/v2${p}`,{headers:{Authorization:`Token ${token}`,Accept:"application/json"}});return{ok:r.ok,status:r.status,json:await r.json().catch(()=>({}))};};
const candidates=[];
for(const z of zones){zone=z;const o=await mk("/organizations");const ol=o.json.organizations??[];if(!o.ok||!ol.length)continue;
 for(const org of ol){const t=await mk(`/teams?organizationId=${org.id}`);
  for(const tm of (t.json.teams??[])){const s=await mk(`/scenarios?teamId=${tm.id}`);
   for(const sc of (s.json.scenarios??[]))if(/fanbasis/i.test(String(sc.name??"")))candidates.push({id:String(sc.id),name:sc.name});}}
 if(candidates.length)break;}
console.log("zone:",zone,"| candidates:",JSON.stringify(candidates.map(c=>c.name)));
for(const c of candidates){
 const bp=await mk(`/scenarios/${c.id}/blueprint`);
 const blueprint=bp.json.response?.blueprint??bp.json;
 const routes=[];const walk=n=>{if(Array.isArray(n)){n.forEach(walk);return;}if(n&&typeof n==="object"){if(Array.isArray(n.routes))for(const r of n.routes)routes.push(r);for(const v of Object.values(n))walk(v);}};
 walk(blueprint);
 console.log(`\n=== "${c.name}": ${routes.length} routes ===`);
 if(routes.length<5)continue;
 const r1=routes[1]??routes[0];
 console.log("route keys:",JSON.stringify(Object.keys(r1)),"| flow[0] keys:",JSON.stringify(Object.keys((r1.flow??[])[0]??{})));
 console.log("sample route JSON (1500ch):",JSON.stringify(r1).slice(0,1500));
 break;
}
