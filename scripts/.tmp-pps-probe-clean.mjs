import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split('\n').filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).trim()]));
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: probes } = await svc.from('onebox_leads').select('id, full_name, ghl_contact_id, visitor_id').eq('slug','pps').ilike('full_name','%onebox probe%');
console.log('probe rows:', probes);
const vids = [...new Set((probes??[]).map(p=>p.visitor_id).filter(Boolean))];
const d1 = await svc.from('onebox_leads').delete().eq('slug','pps').ilike('full_name','%onebox probe%');
console.log('leads deleted:', d1.error??'ok');
if (vids.length) {
  const d2 = await svc.from('onebox_hits').delete().eq('slug','pps').in('visitor_id', vids);
  console.log('hit rows deleted:', d2.error??'ok');
}
