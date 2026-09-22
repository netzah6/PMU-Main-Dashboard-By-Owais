import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split('\n').filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).trim()]));
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const LOC='SfpNMJ5YU9lBkxss47lK';
const { data: probes } = await svc.from('onebox_leads').select('id, ghl_contact_id, ghl_appointment_id, visitor_id, ghl_status').eq('slug','pps').ilike('full_name','%onebox probe%');
console.log('probe rows:', probes);
if (probes?.length) {
  const { data: ag } = await svc.from('ghl_oauth').select('*').eq('id',1).single();
  const lt = await fetch('https://services.leadconnectorhq.com/oauth/locationToken',{method:'POST',headers:{Authorization:`Bearer ${ag.access_token}`,Version:'2021-07-28','Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:new URLSearchParams({companyId:ag.company_id,locationId:LOC}).toString()});
  const ltj = await lt.json();
  const H={Authorization:`Bearer ${ltj.access_token}`,Accept:'application/json'};
  for (const p of probes) {
    if (p.ghl_appointment_id) {
      const d = await fetch(`https://services.leadconnectorhq.com/calendars/events/${p.ghl_appointment_id}`,{method:'DELETE',headers:{...H,Version:'2021-04-15'}});
      console.log('appointment deleted:', p.ghl_appointment_id, d.status);
    }
    if (p.ghl_contact_id) {
      const d = await fetch(`https://services.leadconnectorhq.com/contacts/${p.ghl_contact_id}`,{method:'DELETE',headers:{...H,Version:'2021-07-28'}});
      console.log('contact deleted:', p.ghl_contact_id, d.status);
    }
  }
  const vids=[...new Set(probes.map(p=>p.visitor_id).filter(Boolean))];
  console.log('lead rows deleted:', (await svc.from('onebox_leads').delete().eq('slug','pps').ilike('full_name','%onebox probe%')).error??'ok');
  if(vids.length) console.log('hit rows deleted:', (await svc.from('onebox_hits').delete().eq('slug','pps').in('visitor_id',vids)).error??'ok');
}
