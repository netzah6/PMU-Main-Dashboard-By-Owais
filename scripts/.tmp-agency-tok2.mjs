import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split('\n').filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).trim()]));
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const LOC='SfpNMJ5YU9lBkxss47lK';
const test = async (tok, label) => {
  const r = await fetch(`https://services.leadconnectorhq.com/locations/${LOC}`, { headers: { Authorization:`Bearer ${tok}`, Version:'2021-07-28', Accept:'application/json' } });
  console.log(label, '->', r.status);
  return r.status;
};
// 1. stored per-location token
const { data: locRow } = await svc.from('ghl_oauth_locations').select('*').eq('location_id', LOC).single();
await test(locRow.access_token, 'stored per-location token');
// 2. try its refresh token
const rr = await fetch('https://services.leadconnectorhq.com/oauth/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({ client_id: env.GHL_APP_CLIENT_ID, client_secret: env.GHL_APP_CLIENT_SECRET, grant_type:'refresh_token', refresh_token: locRow.refresh_token, user_type:'Location' }) });
const rj = await rr.json();
console.log('per-location refresh ->', rr.status, rj.access_token ? 'got token' : JSON.stringify(rj).slice(0,150));
// 3. agency-minted location token (bypass the row)
const { data: ag } = await svc.from('ghl_oauth').select('*').eq('id',1).single();
let agTok = ag.access_token;
if (new Date(ag.expires_at).getTime() < Date.now()) {
  const ar = await fetch('https://services.leadconnectorhq.com/oauth/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({ client_id: env.GHL_APP_CLIENT_ID, client_secret: env.GHL_APP_CLIENT_SECRET, grant_type:'refresh_token', refresh_token: ag.refresh_token, user_type:'Company' }) });
  const aj = await ar.json();
  console.log('agency refresh ->', ar.status, aj.access_token ? 'ok' : JSON.stringify(aj).slice(0,150));
  if (aj.access_token) {
    agTok = aj.access_token;
    await svc.from('ghl_oauth').upsert({ id:1, access_token: aj.access_token, refresh_token: aj.refresh_token ?? ag.refresh_token, expires_at: new Date(Date.now()+(aj.expires_in-300)*1000).toISOString(), company_id: aj.companyId ?? ag.company_id, updated_at: new Date().toISOString() });
    console.log('agency row updated');
  }
}
const mint = await fetch('https://services.leadconnectorhq.com/oauth/locationToken', { method:'POST', headers:{ Authorization:`Bearer ${agTok}`, Version:'2021-07-28', 'Content-Type':'application/x-www-form-urlencoded', Accept:'application/json' }, body: new URLSearchParams({ companyId: ag.company_id, locationId: LOC }).toString() });
const mj = await mint.json();
console.log('agency-minted location token ->', mint.status, mj.access_token ? 'got token' : JSON.stringify(mj).slice(0,150));
if (mj.access_token) await test(mj.access_token, 'agency-minted token');
