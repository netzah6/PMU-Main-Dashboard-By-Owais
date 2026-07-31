import fs from 'fs';
const env = {};
for (const line of fs.readFileSync('.env.local','utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g,'');
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const rows = await fetch(`${SB}/rest/v1/ghl_contacts?or=(contact_name.ilike.*melba*,contact_name.ilike.*czosnowski*,email.ilike.*czosnowski*)&select=id,location_id,owner_key,contact_name,email,phone&limit=10`, { headers: H }).then(r=>r.json());
console.log('contacts found:', rows.length);
console.log(JSON.stringify(rows, null, 1));
