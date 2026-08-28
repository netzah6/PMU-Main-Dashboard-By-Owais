// Re-match Commas payers vs onebox leads by email OR normalized name; cleanup probe
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split('\n').filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).trim()]));
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const KEY='lKI2gJ56jiZtjQA08FKyzW8HmgLCvC5n';
const since=Date.parse('2026-08-19T00:00:00Z');
const norm=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'');
const txns=[];
for(let page=1;page<=20;page++){
  const r=await fetch(`https://www.fanbasis.com/public-api/checkout-sessions/transactions?page=${page}&per_page=100`,{headers:{'x-api-key':KEY,Accept:'application/json'}});
  if(!r.ok)break;
  const j=await r.json();const c=j.data??j;const list=c.transactions??j.transactions??[];
  if(!list.length)break;
  let allOlder=true;
  for(const t of list){
    const created=String(t.transaction_date??t.created_at??t.date??'');
    const ms=Date.parse(created);
    if(Number.isFinite(ms)&&ms>=since)allOlder=false;else continue;
    const fan=t.fan??{};const prod=t.product??t.checkout_session??{};
    const amt=Number(t.amount??(t.amount_cents?t.amount_cents/100:NaN));
    const title=String(prod.title??t.product_title??'?');
    if(!/tonni|luscious|blossom|beaut.*hub|browology|modern artistry/i.test(title))continue;
    if(amt<10)continue;
    txns.push({d:created.slice(0,10),title:title.slice(0,35),email:String(fan.email??t.email??'').toLowerCase().trim(),name:String(fan.name??'').trim()});
  }
  if(list.length<100||allOlder)break;
}
const { data: obl } = await svc.from('onebox_leads').select('slug, full_name, ghl_status, picked_time_at, answers, created_at').gte('created_at','2026-08-12');
const byEmail=new Map(), byName=new Map();
for(const l of obl??[]){
  const em=String((l.answers||{}).email??'').toLowerCase().trim();
  if(em&&!byEmail.has(em))byEmail.set(em,l);
  const nk=norm(l.full_name);
  if(nk&&!byName.has(nk))byName.set(nk,l);
}
let ob=0, orig=0;
for(const t of txns){
  const m=(t.email&&byEmail.get(t.email))||(norm(t.name)&&byName.get(norm(t.name)));
  if(m){ob++;console.log(t.d,'|',t.title,'| ONEBOX:',m.slug,m.ghl_status,'picked='+(m.picked_time_at?'y':'n'));}
  else{orig++;console.log(t.d,'|',t.title,'| original-side |',t.name.split(' ')[0]);}
}
console.log(`\nSINCE 8/19: onebox-matched=${ob}, original-side=${orig}`);
// cleanup probe
const { data: probe } = await svc.from('onebox_leads').select('id, ghl_contact_id, slug').eq('slug','blossom-beauty').ilike('full_name','%onebox probe%');
console.log('probe rows:', probe);
if(probe?.length){
  const { data: cl } = await svc.from('onebox_clients').select('location_id').eq('slug','blossom-beauty').single();
  const { data: row } = await svc.from('ghl_oauth').select('*').eq('id',1).single();
  const lt=await fetch('https://services.leadconnectorhq.com/oauth/locationToken',{method:'POST',headers:{Authorization:`Bearer ${row.access_token}`,Version:'2021-07-28','Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:new URLSearchParams({companyId:row.company_id,locationId:cl.location_id}).toString()});
  const ltj=await lt.json();
  for(const p of probe){
    if(p.ghl_contact_id){
      const d=await fetch(`https://services.leadconnectorhq.com/contacts/${p.ghl_contact_id}`,{method:'DELETE',headers:{Authorization:`Bearer ${ltj.access_token}`,Version:'2021-07-28'}});
      console.log('deleted GHL probe contact:', p.ghl_contact_id, d.status);
    }
  }
  const del=await svc.from('onebox_leads').delete().ilike('full_name','%onebox probe%').eq('slug','blossom-beauty');
  console.log('probe lead rows deleted:', del.error??'ok');
}
