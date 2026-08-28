// Match Commas payers (since 8/15) against onebox_leads to see which side paid
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split('\n').filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).trim()]));
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const KEY = 'lKI2gJ56jiZtjQA08FKyzW8HmgLCvC5n';
const since = Date.parse('2026-08-15T00:00:00Z');
const txns = [];
for (let page = 1; page <= 20; page++) {
  const r = await fetch(`https://www.fanbasis.com/public-api/checkout-sessions/transactions?page=${page}&per_page=100`, { headers: { 'x-api-key': KEY, Accept: 'application/json' } });
  if (!r.ok) break;
  const j = await r.json(); const c = j.data ?? j;
  const list = c.transactions ?? j.transactions ?? [];
  if (!list.length) break;
  let allOlder = true;
  for (const t of list) {
    const created = String(t.transaction_date ?? t.created_at ?? t.date ?? '');
    const ms = Date.parse(created);
    if (Number.isFinite(ms) && ms >= since) allOlder = false; else continue;
    const fan = t.fan ?? {}; const prod = t.product ?? t.checkout_session ?? {};
    const amt = Number(t.amount ?? (t.amount_cents ? t.amount_cents/100 : NaN));
    const title = String(prod.title ?? t.product_title ?? '?');
    if (!/tonni|luscious|blossom|beaut.*hub|browology|modern artistry/i.test(title)) continue;
    if (amt < 10) continue; // skip $1 team tests
    txns.push({ d: created.slice(0,10), title: title.slice(0,40), email: String(fan.email ?? t.email ?? '').toLowerCase().trim(), name: String(fan.name ?? '').trim() });
  }
  if (list.length < 100 || allOlder) break;
}
console.log('deposit-size txns since 8/15 for test clients:', txns.length);
const { data: obl } = await svc.from('onebox_leads').select('slug, phone, full_name, ghl_status, picked_time_at, created_at, answers').gte('created_at','2026-08-10');
const byEmail = new Map();
for (const l of obl ?? []) {
  const em = String((l.answers||{}).email ?? '').toLowerCase().trim();
  if (em) byEmail.set(em, l);
}
for (const t of txns) {
  const m = t.email ? byEmail.get(t.email) : null;
  console.log(t.d, '|', t.title, '|', m ? `ONEBOX LEAD (${m.slug}, status=${m.ghl_status}, picked=${m.picked_time_at? 'yes':'no'})` : 'not-in-onebox (original side)');
}
