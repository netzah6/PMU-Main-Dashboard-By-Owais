// Verify then remove the B2B test probe: lead row -> GHL appointment + contact -> purge rows
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split('\n').filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).trim()]));
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const LOC='SfpNMJ5YU9lBkxss47lK';
const { data: leads } = await svc.from('onebox_leads').select('*').eq('slug','pmu-bookings');
console.log('lead rows:', (leads||[]).map(l=>({id:l.id,name:l.full_name,status:l.ghl_status,appt:l.ghl_appointment_id,contact:l.ghl_contact_id,picked:!!l.picked_time_at})));
// location token
const { data: row } = await svc.from('ghl_oauth').select('*').eq('id',1).single();
const lt = await fetch('https://services.leadconnectorhq.com/oauth/locationToken',{method:'POST',headers:{Authorization:`Bearer ${row.access_token}`,Version:'2021-07-28','Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:new URLSearchParams({companyId:row.company_id,locationId:LOC}).toString()});
const ltj = await lt.json();
const H={Authorization:`Bearer ${ltj.access_token}`,Accept:'application/json'};
for (const l of leads||[]) {
  if (l.ghl_appointment_id) {
    const d = await fetch(`https://services.leadconnectorhq.com/calendars/events/${l.ghl_appointment_id}`,{method:'DELETE',headers:{...H,Version:'2021-04-15'}});
    console.log('delete appointment', l.ghl_appointment_id, d.status);
  }
  if (l.ghl_contact_id) {
    const d = await fetch(`https://services.leadconnectorhq.com/contacts/${l.ghl_contact_id}`,{method:'DELETE',headers:{...H,Version:'2021-07-28'}});
    console.log('delete contact', l.ghl_contact_id, d.status);
  }
}
const del1 = await svc.from('onebox_leads').delete().eq('slug','pmu-bookings');
const del2 = await svc.from('onebox_hits').delete().eq('slug','pmu-bookings');
console.log('purged lead rows:', del1.error??'ok', '| hit rows:', del2.error??'ok');
