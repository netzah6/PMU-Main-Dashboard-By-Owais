import fs from 'fs';
const env = {};
for (const line of fs.readFileSync('.env.local','utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g,'');
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const r = await fetch(`${SB}/rest/v1/ghl_contacts?or=(full_name.ilike.*melba*,email.ilike.*melba*,email.ilike.*czosnowski*)&select=id,location_id,full_name,email,phone,owner_key&limit=10`, { headers: H });
const rows = await r.json();
console.log(JSON.stringify(rows, null, 1));
