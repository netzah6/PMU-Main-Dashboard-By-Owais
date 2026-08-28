// Read-only: list Commas/Fanbasis transactions since Aug 10, group per product/day
const KEY = 'lKI2gJ56jiZtjQA08FKyzW8HmgLCvC5n'; // public embed key (read fallback, ships in funnel HTML)
const since = Date.parse('2026-08-10T00:00:00Z');
const out = [];
for (let page = 1; page <= 40; page++) {
  const r = await fetch(`https://www.fanbasis.com/public-api/checkout-sessions/transactions?page=${page}&per_page=100`, { headers: { 'x-api-key': KEY, Accept: 'application/json' } });
  if (!r.ok) { console.log('HTTP', r.status, (await r.text()).slice(0,200)); break; }
  const j = await r.json();
  const c = j.data ?? j;
  const list = c.transactions ?? j.transactions ?? [];
  if (!list.length) break;
  let allOlder = true;
  for (const t of list) {
    const created = String(t.transaction_date ?? t.created_at ?? t.date ?? '');
    const ms = Date.parse(created);
    const fan = t.fan ?? {};
    const prod = t.product ?? t.checkout_session ?? {};
    if (Number.isFinite(ms) && ms >= since) allOlder = false;
    if (!Number.isFinite(ms) || ms >= since) out.push({
      d: created.slice(0,10),
      amt: Number(t.amount ?? (t.amount_cents ? t.amount_cents/100 : NaN)),
      product: (prod.title ?? t.product_title ?? '?'),
      email: String(fan.email ?? t.email ?? '').toLowerCase(),
      status: String(t.status ?? t.state ?? ''),
    });
  }
  if (list.length < 100 || allOlder) break;
}
console.log('total txns since 8/10:', out.length);
const byDay = {};
for (const t of out) byDay[t.d] = (byDay[t.d]||0)+1;
console.log('per day:', JSON.stringify(byDay));
const interesting = out.filter(t => /tonni|luscious|blossom|beaut.*hub|browology|diana|cara bella|nicole/i.test(String(t.product)));
console.log('--- txns for the clients under investigation ---');
for (const t of interesting) console.log(t.d, '|', String(t.product).slice(0,45), '|', t.amt, '|', t.status, '|', t.email.slice(0,3)+'***');
