import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split('\n').filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).trim()]));
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const LOC='SfpNMJ5YU9lBkxss47lK';
// 1. per-location install token?
const { data: locRow } = await svc.from('ghl_oauth_locations').select('location_id, expires_at, updated_at').eq('location_id', LOC).maybeSingle();
console.log('per-location row:', locRow ? JSON.stringify(locRow) : 'none');
// 2. agency row age
const { data: ag } = await svc.from('ghl_oauth').select('expires_at, updated_at, company_id').eq('id',1).single();
console.log('agency row: expires', ag.expires_at, 'updated', ag.updated_at);
// 3. recent lead ghl_status for agency-location funnels by day
const { data: leads } = await svc.from('onebox_leads').select('slug, ghl_status, created_at').in('slug',['pps','pmu-bookings']).gte('created_at','2026-09-14').order('created_at');
const agg={};
for(const l of leads??[]){const d=l.created_at.slice(5,10); const k=d+' '+l.slug+' '+l.ghl_status; agg[k]=(agg[k]||0)+1;}
console.log('lead ghl_status by day:', JSON.stringify(agg,null,1));
