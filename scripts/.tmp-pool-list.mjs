import fs from 'fs';
const env = {};
for (const line of fs.readFileSync('.env.local','utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g,'');
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const rows = await fetch(`${SB}/rest/v1/pool_accounts?status=eq.available&select=location_id,pool_name,a2p`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }).then(r=>r.json());
rows.sort((a,b)=> Number(a.pool_name.match(/(\d+)$/)[1]) - Number(b.pool_name.match(/(\d+)$/)[1]));
console.log('count:', rows.length);
console.log(rows.map(r=>`${r.pool_name.replace('Clean New Account ','')}:${r.location_id}`).join(' '));
