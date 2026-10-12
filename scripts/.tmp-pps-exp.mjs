import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split('\n').filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).trim()]));
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
// pause the idle B2B experiment (nothing ever pointed at /s/pmu-bookings)
const p = await svc.from('onebox_experiments').update({ status: 'paused' }).eq('slug','pmu-bookings').eq('status','running');
console.log('old pmu-bookings experiment paused:', p.error ?? 'ok');
// one running experiment per slug
await svc.from('onebox_experiments').update({ status: 'paused' }).eq('slug','pps').eq('status','running');
const { data: exp, error } = await svc.from('onebox_experiments').insert({ slug: 'pps', name: 'Original funnel vs Pay-Per-Show' }).select('id, status').single();
if (error) { console.log('insert error:', error.message); process.exit(1); }
const { error: vErr } = await svc.from('onebox_variants').insert([
  { experiment_id: exp.id, vkey: 'a', label: 'Original funnel (GHL)', kind: 'external', target: 'https://www.pmu-bookings.com/bookings-3-6131-ab-ghl', weight: 50 },
  { experiment_id: exp.id, vkey: 'b', label: 'Pay-Per-Show one-box', kind: 'onebox', target: null, weight: 50 },
]);
console.log('experiment armed:', JSON.stringify(exp), '| variants:', vErr ? vErr.message : 'ok');
