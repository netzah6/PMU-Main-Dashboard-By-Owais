import fs from 'fs';
const env = {};
for (const line of fs.readFileSync('.env.local','utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g,'');
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const LOC = '6LNULmG33OpGbk4Th57J';
const row = (await fetch(`${SB}/rest/v1/ghl_oauth?id=eq.1&select=access_token,refresh_token,expires_at,company_id`, { headers: H }).then(r=>r.json()))[0];
let tok = row.access_token;
const r = await fetch('https://services.leadconnectorhq.com/oauth/token', {
  method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
  body: new URLSearchParams({ client_id: env.GHL_APP_CLIENT_ID, client_secret: env.GHL_APP_CLIENT_SECRET, grant_type:'refresh_token', refresh_token: row.refresh_token, user_type: 'Company' })
}).then(r=>r.json());
if (r.access_token) {
  tok = r.access_token;
  await fetch(`${SB}/rest/v1/ghl_oauth?id=eq.1`, { method:'PATCH', headers:{ apikey:KEY, Authorization:`Bearer ${KEY}`, 'Content-Type':'application/json' },
    body: JSON.stringify({ access_token: r.access_token, refresh_token: r.refresh_token || row.refresh_token, expires_at: new Date(Date.now()+(Number(r.expires_in||86400)-300)*1000).toISOString(), updated_at: new Date().toISOString() })});
  console.log('agency token refreshed ✓');
} else { console.log('refresh failed:', JSON.stringify(r).slice(0,200)); }
const lt = await fetch('https://services.leadconnectorhq.com/oauth/locationToken', {
  method: 'POST', headers: { Authorization: `Bearer ${tok}`, Version: '2021-07-28', 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ companyId: row.company_id || 'jU225y7HB756kCAH7d0X', locationId: LOC })
}).then(r=>r.json());
if (!lt.access_token) { console.log('loc token fail:', JSON.stringify(lt).slice(0,200)); process.exit(1); }
const HL = { Authorization: `Bearer ${lt.access_token}`, Version: '2021-07-28' };
const wf = await fetch(`https://services.leadconnectorhq.com/workflows/?locationId=${LOC}`, { headers: HL }).then(r=>r.json());
const pp = await fetch(`https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${LOC}`, { headers: HL }).then(r=>r.json());
const ct = await fetch(`https://services.leadconnectorhq.com/contacts/?locationId=${LOC}&limit=1`, { headers: HL }).then(r=>r.json());
console.log('TRUE STATE — contacts:', ct.meta?.total, '| workflows:', (wf.workflows||[]).length, '| pipelines:', (pp.pipelines||[]).length);
