import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split('\n').filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).trim()]));
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: lead } = await svc.from('onebox_leads').select('id, ghl_contact_id, answers, visitor_id').eq('slug','pps').ilike('full_name','%onebox probe%').order('created_at',{ascending:false}).limit(1).maybeSingle();
console.log('DB lead answers.utm_ad:', lead?.answers?.utm_ad, '| utm_adset:', lead?.answers?.utm_adset);
if (lead?.ghl_contact_id) {
  const { data: ag } = await svc.from('ghl_oauth').select('*').eq('id',1).single();
  const lt = await fetch('https://services.leadconnectorhq.com/oauth/locationToken',{method:'POST',headers:{Authorization:`Bearer ${ag.access_token}`,Version:'2021-07-28','Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:new URLSearchParams({companyId:ag.company_id,locationId:'SfpNMJ5YU9lBkxss47lK'}).toString()});
  const ltj = await lt.json();
  const H = {Authorization:`Bearer ${ltj.access_token}`,Version:'2021-07-28',Accept:'application/json'};
  const c = await (await fetch(`https://services.leadconnectorhq.com/contacts/${lead.ghl_contact_id}`,{headers:H})).json();
  const fields = c.contact?.customFields ?? [];
  const F = { HUNv21W1zPbr6VaiERWc: 'UTM Ad', SLuxabPh3ySzo6I3mVPl: 'UTM Adset' };
  for (const f of fields) if (F[f.id]) console.log('GHL contact field', F[f.id], '=', JSON.stringify(f.value));
  const tags = c.contact?.tags ?? [];
  console.log('contact tags:', tags.join(', '));
  // cleanup: contact + rows
  const d = await fetch(`https://services.leadconnectorhq.com/contacts/${lead.ghl_contact_id}`,{method:'DELETE',headers:H});
  console.log('probe contact deleted:', d.status);
}
console.log('lead rows deleted:', (await svc.from('onebox_leads').delete().eq('slug','pps').ilike('full_name','%onebox probe%')).error ?? 'ok');
if (lead?.visitor_id) console.log('hit rows deleted:', (await svc.from('onebox_hits').delete().eq('slug','pps').eq('visitor_id', lead.visitor_id)).error ?? 'ok');
