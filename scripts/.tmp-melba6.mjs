import fs from 'fs';
const env = {};
for (const line of fs.readFileSync('.env.local','utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g,'');
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const MAIN = 'SfpNMJ5YU9lBkxss47lK', CONV = 'V3vmWDpFrZdJ0eT8L3WE';
const agencyTok = (await fetch(`${SB}/rest/v1/ghl_oauth?id=eq.1&select=access_token`, { headers: H }).then(r=>r.json()))[0].access_token;
const lt = await fetch('https://services.leadconnectorhq.com/oauth/locationToken', {
  method: 'POST', headers: { Authorization: `Bearer ${agencyTok}`, Version: '2021-07-28', 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ companyId: 'jU225y7HB756kCAH7d0X', locationId: MAIN })
}).then(r=>r.json());
const HC = { Authorization: `Bearer ${lt.access_token}`, Version: '2021-04-15' };

let all = [], lastId = '';
for (let i = 0; i < 10; i++) {
  let u = `https://services.leadconnectorhq.com/conversations/${CONV}/messages?limit=100`;
  if (lastId) u += `&lastMessageId=${lastId}`;
  const j = await fetch(u, { headers: HC }).then(r=>r.json());
  const msgs = j.messages?.messages || j.messages || [];
  if (!msgs.length) break;
  all.push(...msgs);
  const next = j.messages?.lastMessageId || msgs[msgs.length-1]?.id;
  if (!next || next === lastId || !(j.messages?.nextPage)) { lastId = next; if (!(j.messages?.nextPage)) break; }
  lastId = next;
}
console.log('total messages:', all.length);
const kw = /\bads?\b|ad spend|spend|budget|meta|facebook|\$?300|\$?600|\$?20\s*\/?\s*day|\$?10\s*\/?\s*day|reduce|lower|decrease|pause/i;
const hits = all.filter(m => m.direction === 'inbound' && kw.test(String(m.body||'')));
hits.sort((a,b) => new Date(a.dateAdded) - new Date(b.dateAdded));
console.log('--- ALL inbound (from Melba) messages mentioning ads/spend/budget, chronological:');
for (const m of hits) {
  console.log(`\n[${(m.dateAdded||'').slice(0,16)}] ${String(m.body).replace(/\s+/g,' ').trim().slice(0, 500)}`);
}
