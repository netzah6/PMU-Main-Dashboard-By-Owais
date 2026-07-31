import fs from 'fs';
const env = {};
for (const line of fs.readFileSync('.env.local','utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g,'');
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const MAIN = 'SfpNMJ5YU9lBkxss47lK';
const agencyTok = (await fetch(`${SB}/rest/v1/ghl_oauth?id=eq.1&select=access_token`, { headers: H }).then(r=>r.json()))[0].access_token;
const lt = await fetch('https://services.leadconnectorhq.com/oauth/locationToken', {
  method: 'POST', headers: { Authorization: `Bearer ${agencyTok}`, Version: '2021-07-28', 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ companyId: 'jU225y7HB756kCAH7d0X', locationId: MAIN })
}).then(r=>r.json());
const tok = lt.access_token;
const j = await fetch(`https://services.leadconnectorhq.com/contacts/?locationId=${MAIN}&limit=20&query=czosnowski`, {
  headers: { Authorization: `Bearer ${tok}`, Version: '2021-07-28' }
}).then(r=>r.json());
for (const c of (j.contacts||[])) console.log('CONTACT:', c.id, '|', c.contactName || `${c.firstName||''} ${c.lastName||''}`, '|', c.email || '', '|', c.phone || '');
if (!(j.contacts||[]).length) {
  const j2 = await fetch(`https://services.leadconnectorhq.com/contacts/?locationId=${MAIN}&limit=20&query=melba`, {
    headers: { Authorization: `Bearer ${tok}`, Version: '2021-07-28' }
  }).then(r=>r.json());
  for (const c of (j2.contacts||[])) console.log('CONTACT(melba):', c.id, '|', c.contactName || `${c.firstName||''} ${c.lastName||''}`, '|', c.email || '', '|', c.phone || '');
}
