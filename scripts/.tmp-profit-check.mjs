import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split('\n').filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).trim()]));
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const LOC='SfpNMJ5YU9lBkxss47lK', CAL='sM5ENt37b5MGwKDOSOrl', START=new Date('2026-09-23T19:00:00Z').getTime();
const { data: ag } = await svc.from('ghl_oauth').select('*').eq('id',1).single();
const lt = await fetch('https://services.leadconnectorhq.com/oauth/locationToken',{method:'POST',headers:{Authorization:`Bearer ${ag.access_token}`,Version:'2021-07-28','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({companyId:ag.company_id,locationId:LOC}).toString()});
const tok=(await lt.json()).access_token;
const H={Authorization:`Bearer ${tok}`,Accept:'application/json'};
const { data: leads } = await svc.from('onebox_leads').select('ghl_contact_id, ghl_appointment_id').eq('slug','pps').gte('created_at','2026-09-23T19:00:00Z');
const ourC=new Set(leads.map(l=>l.ghl_contact_id).filter(Boolean));
const ourA=new Set(leads.map(l=>l.ghl_appointment_id).filter(Boolean));
const obIds=[...new Set(leads.filter(l=>l.ghl_appointment_id).map(l=>l.ghl_contact_id).filter(Boolean))];
const ev=await (await fetch(`https://services.leadconnectorhq.com/calendars/events?locationId=${LOC}&calendarId=${CAL}&startTime=${START}&endTime=${Date.now()+86400000*90}`,{headers:{...H,Version:'2021-04-15'}})).json();
const extIds=[...new Set((ev.events||[]).filter(e=>e.appointmentStatus!=='cancelled').filter(e=>(e.dateAdded?new Date(e.dateAdded).getTime():START)>=START).filter(e=>(!e.id||!ourA.has(e.id))&&e.contactId&&!ourC.has(e.contactId)).map(e=>e.contactId))];
const pj=await (await fetch(`https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${LOC}`,{headers:{...H,Version:'2021-07-28'}})).json();
const sm=new Map();
for(const p of pj.pipelines||[]) for(const s of p.stages||[]) sm.set(s.id,{stage:s.name||'',pipe:p.name||''});
const SH=/strategy booked|didn'?t close|don'?t have money|disqualified|paid deposit|showed|closed paying/i, CL=/closed paying client/i, JR=/client journey/i;
async function cls(id){
  const r=await fetch(`https://services.leadconnectorhq.com/opportunities/search?location_id=${LOC}&contact_id=${id}`,{headers:{...H,Version:'2021-07-28'}});
  if(!r.ok)return{s:0,c:0};
  const j=await r.json(); let s=0,c=0,n='';
  for(const o of j.opportunities||[]){const x=sm.get(o.pipelineStageId); if(!x)continue;
    if(JR.test(x.pipe)||CL.test(x.stage)){c=1;s=1;n=o.name;} else if(SH.test(x.stage))s=1;}
  return{s,c,n};
}
async function run(ids,label){
  let s=0,c=0; const names=[];
  for(let i=0;i<ids.length;i+=8){const rs=await Promise.all(ids.slice(i,i+8).map(cls)); for(const x of rs){s+=x.s; if(x.c){c++; names.push(x.n);}}}
  console.log(label,'calls:',ids.length,'showed:',s,'closed:',c, names.length?('('+names.join(' | ')+')'):'');
}
await run(extIds,'ORIGINAL side:');
await run(obIds,'PPS side:');
