import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split('\n').filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).trim()]));
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
// one running experiment per slug: pause any stragglers first (idempotent)
await svc.from('onebox_experiments').update({ status: 'paused' }).eq('slug','pmu-bookings').eq('status','running');
const { data: exp, error } = await svc.from('onebox_experiments').insert({ slug: 'pmu-bookings', name: 'B2B: original vs one-box' }).select('id, status, created_at').single();
if (error) { console.log('exp insert error:', error.message); process.exit(1); }
console.log('experiment:', exp);
const { error: vErr } = await svc.from('onebox_variants').insert([
  { experiment_id: exp.id, vkey: 'a', label: 'Original funnel (GHL)', kind: 'external', target: 'https://www.pmu-bookings.com/bookings-3-6131-ab-ghl', weight: 50 },
  { experiment_id: exp.id, vkey: 'b', label: 'One-box funnel', kind: 'onebox', target: null, weight: 50 },
]);
console.log('variants:', vErr ? vErr.message : 'ok');
