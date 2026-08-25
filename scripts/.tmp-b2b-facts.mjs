// Read-only: mint agency->location token, list calendars + custom fields
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split('\n').filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).trim()]));
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const LOC = 'SfpNMJ5YU9lBkxss47lK';
const { data: row } = await svc.from('ghl_oauth').select('*').eq('id',1).single();
let agencyTok = row.access_token, companyId = row.company_id;
if (new Date(row.expires_at).getTime() < Date.now()) {
  const r = await fetch('https://services.leadconnectorhq.com/oauth/token', {method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.GHL_APP_CLIENT_ID,client_secret:env.GHL_APP_CLIENT_SECRET,grant_type:'refresh_token',refresh_token:row.refresh_token,user_type:'Company'})});
  const j = await r.json();
  if(!j.access_token){console.log('agency refresh failed',j);process.exit(1)}
  agencyTok=j.access_token; companyId=j.companyId||companyId;
  await svc.from('ghl_oauth').upsert({id:1,access_token:j.access_token,refresh_token:j.refresh_token||row.refresh_token,expires_at:new Date(Date.now()+(j.expires_in-300)*1000).toISOString(),company_id:companyId,updated_at:new Date().toISOString()});
  console.log('agency token refreshed');
}
const lt = await fetch('https://services.leadconnectorhq.com/oauth/locationToken',{method:'POST',headers:{Authorization:`Bearer ${agencyTok}`,Version:'2021-07-28','Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:new URLSearchParams({companyId,locationId:LOC}).toString()});
const ltj = await lt.json();
if(!ltj.access_token){console.log('location token failed',ltj);process.exit(1)}
const H = {Authorization:`Bearer ${ltj.access_token}`,Accept:'application/json'};
const cals = await (await fetch(`https://services.leadconnectorhq.com/calendars/?locationId=${LOC}`,{headers:{...H,Version:'2021-04-15'}})).json();
console.log('=== CALENDARS (name | id | slotDuration | active) ===');
for (const c of cals.calendars||[]) console.log(`${c.name} | ${c.id} | ${c.slotDuration??'?'}min | active:${c.isActive}`);
const cf = await (await fetch(`https://services.leadconnectorhq.com/locations/${LOC}/customFields`,{headers:{...H,Version:'2021-07-28'}})).json();
console.log('\n=== CUSTOM FIELDS (name | id) — filtered to likely B2B/utm ===');
for (const f of cf.customFields||[]) {
  const n=String(f.name||'');
  if (/area|spot|book|handle|soon|ready|long|artist|revenue|apart|utm|ad|survey|discovery/i.test(n)) console.log(`${n} | ${f.id}`);
}
console.log('\ntotal fields:', (cf.customFields||[]).length);
