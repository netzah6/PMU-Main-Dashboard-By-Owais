import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split('\n').filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).trim()]));
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const LOC='SfpNMJ5YU9lBkxss47lK';
const { data: row } = await svc.from('ghl_oauth').select('*').eq('id',1).single();
const lt = await fetch('https://services.leadconnectorhq.com/oauth/locationToken',{method:'POST',headers:{Authorization:`Bearer ${row.access_token}`,Version:'2021-07-28','Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:new URLSearchParams({companyId:row.company_id,locationId:LOC}).toString()});
const ltj = await lt.json();
const H={Authorization:`Bearer ${ltj.access_token}`,Version:'2021-07-28',Accept:'application/json','Content-Type':'application/json'};
const list = await (await fetch(`https://services.leadconnectorhq.com/locations/${LOC}/tags`,{headers:H})).json();
const have = (list.tags||[]).find(t=>String(t.name).toLowerCase()==='b2b-onebox-survey');
if (have) { console.log('tag exists:', have.id); }
else {
  const c = await fetch(`https://services.leadconnectorhq.com/locations/${LOC}/tags`,{method:'POST',headers:H,body:JSON.stringify({name:'b2b-onebox-survey'})});
  console.log('tag create:', c.status, JSON.stringify(await c.json()).slice(0,200));
}
