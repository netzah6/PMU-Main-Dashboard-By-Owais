import fs from 'fs';
const env = {};
for (const line of fs.readFileSync('.env.local','utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g,'');
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const MAIN = 'SfpNMJ5YU9lBkxss47lK', CONTACT = 'LeIOqQ6XW61e3gu6uSzx';
const agencyTok = (await fetch(`${SB}/rest/v1/ghl_oauth?id=eq.1&select=access_token`, { headers: H }).then(r=>r.json()))[0].access_token;
const lt = await fetch('https://services.leadconnectorhq.com/oauth/locationToken', {
  method: 'POST', headers: { Authorization: `Bearer ${agencyTok}`, Version: '2021-07-28', 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ companyId: 'jU225y7HB756kCAH7d0X', locationId: MAIN })
}).then(r=>r.json());
const tok = lt.access_token;
const HC = { Authorization: `Bearer ${tok}`, Version: '2021-04-15' };
const convs = await fetch(`https://services.leadconnectorhq.com/conversations/search?locationId=${MAIN}&contactId=${CONTACT}`, { headers: HC }).then(r=>r.json());
console.log('conversations:', (convs.conversations||[]).length);
for (const cv of (convs.conversations||[])) {
  console.log('--- conversation', cv.id, '| lastMsg:', cv.lastMessageDate);
  let msgs = [], page = await fetch(`https://services.leadconnectorhq.com/conversations/${cv.id}/messages?limit=100`, { headers: HC }).then(r=>r.json());
  msgs = page.messages?.messages || page.messages || [];
  console.log('   messages fetched:', msgs.length);
  const kw = /ad spend|adspend|spend|budget|reduce|lower|pause|slow down|\$\s?\d+\s?\/?\s?day|daily/i;
  for (const m of msgs) {
    const body = String(m.body || '').replace(/\s+/g, ' ').trim();
    if (!body) continue;
    if (kw.test(body)) {
      const dir = m.direction === 'inbound' ? 'FROM MELBA' : 'to melba';
      console.log(`   [${(m.dateAdded||'').slice(0,16)}] (${dir}): ${body.slice(0, 300)}`);
    }
  }
}
