import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split('\n').filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).trim()]));
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: row } = await svc.from('onebox_clients').select('location_id, extras').eq('slug','pps').single();
console.log('pps location:', row.location_id, '| b2b extras:', JSON.stringify(row.extras?.b2b||{}).slice(0,300));
// real availability for that calendar
const cal = row.extras?.b2b?.calendarId;
const start = Math.ceil(Date.now()/300000)*300000, end = start + 7*86400000;
const r = await fetch(`https://pmu-main-dashboard-by-owais1.vercel.app/api/onebox/slots?slug=pps&start=${start}&end=${end}`);
const j = await r.json();
const firstDay = j.ok ? Object.entries(j.dates).find(e=>e[1].length) : null;
const iso = firstDay ? firstDay[1][firstDay[1].length-1] : null;
console.log('slots ok:', j.ok, '| probe slot:', iso);
if (iso) {
  const b = await fetch('https://pmu-main-dashboard-by-owais1.vercel.app/api/onebox/book', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ slug:'pps', full_name:'Onebox Probe', phone:'(305) 555-0142', email:'onebox-pps-probe@example.com', startTime: iso, pageUrl:'debug' }),
  });
  console.log('book HTTP', b.status, '|', (await b.text()).slice(0,300));
}
