-- Client Health tab (owner 2026-10-05). Helpers + the per-client base view.
-- Applied to the live project; re-runnable.

-- Name key: lowercase, "(alias)" dropped, punctuation → spaces.
create or replace function public.health_nk(t text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select trim(pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.regexp_replace(coalesce(t, ''), '\(.*?\)', ' ', 'g')), '[^a-z0-9]+', ' ', 'g'))
$$;

-- Business key: letters + digits only, and a trailing "- ad account" dropped
-- (Clients Master writes "Wake Up Beautiful - Ad Account"; deposits don't).
create or replace function public.health_biz(t text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.regexp_replace(coalesce(t, ''), '\s*-\s*ad\s*account.*$', '', 'i')), '[^a-z0-9]', '', 'g')
$$;

create or replace function public.health_date_parts(a int, b int, y int, day_first boolean) returns date
language plpgsql immutable parallel safe set search_path = '' as $$
begin
  if y < 2015 or y > 2100 then return null; end if;
  if day_first then return pg_catalog.make_date(y, b, a); else return pg_catalog.make_date(y, a, b); end if;
exception when others then return null;
end $$;

-- DD/MM/YYYY (or ISO) → date; anything else → null.
create or replace function public.health_date_dmy(t text) returns date
language plpgsql immutable parallel safe set search_path = '' as $$
declare m text[];
begin
  t := pg_catalog.btrim(coalesce(t, ''));
  m := pg_catalog.regexp_match(t, '^(\d{1,2})/(\d{1,2})/(\d{4})');
  if m is not null then return public.health_date_parts(m[1]::int, m[2]::int, m[3]::int, true); end if;
  m := pg_catalog.regexp_match(t, '^(\d{4})-(\d{2})-(\d{2})');
  if m is not null then return public.health_date_parts(m[3]::int, m[2]::int, m[1]::int, true); end if;
  return null;
end $$;

-- MM/DD/YYYY (or ISO) → date.
create or replace function public.health_date_mdy(t text) returns date
language plpgsql immutable parallel safe set search_path = '' as $$
declare m text[];
begin
  t := pg_catalog.btrim(coalesce(t, ''));
  m := pg_catalog.regexp_match(t, '^(\d{1,2})/(\d{1,2})/(\d{4})');
  if m is not null then return public.health_date_parts(m[1]::int, m[2]::int, m[3]::int, false); end if;
  m := pg_catalog.regexp_match(t, '^(\d{4})-(\d{2})-(\d{2})');
  if m is not null then return public.health_date_parts(m[3]::int, m[2]::int, m[1]::int, true); end if;
  return null;
end $$;

-- Launch Call holds "Friday, April 17, 2026 11:00" or DD/MM/YYYY (or just true/false).
create or replace function public.health_date_launch(t text) returns date
language plpgsql immutable parallel safe set search_path = '' as $$
declare s text;
begin
  s := pg_catalog.substring(coalesce(t, ''), '[A-Za-z]+ \d{1,2}, \d{4}');
  if s is not null then
    begin return pg_catalog.to_date(s, 'FMMonth FMDD, YYYY'); exception when others then return null; end;
  end if;
  return public.health_date_dmy(t);
end $$;

revoke execute on function public.health_nk(text), public.health_biz(text), public.health_date_parts(int, int, int, boolean),
  public.health_date_dmy(text), public.health_date_mdy(text), public.health_date_launch(text) from public, anon, authenticated;
-- the view calls them as the querying role (the app's service role)
grant execute on function public.health_nk(text), public.health_biz(text), public.health_date_parts(int, int, int, boolean),
  public.health_date_dmy(text), public.health_date_mdy(text), public.health_date_launch(text) to service_role;

-- One row per LIVE client with the raw facts the app scores green / orange /
-- red (src/lib/client-health.ts): start-date candidates, every dated ledger
-- payment (2026 payments come from the Financing sheet in the app), deposit
-- dates (both date formats, one per person per day, VOID out), refunds,
-- sessions done (latest tracking row WITH a number, by sheet order — the Date
-- column has year typos), prices, ads, and risk signals. Service role only.
drop view if exists public.client_health_base;
create view public.client_health_base as
with live as materialized (
  select cm.sheet_row, cm.data d,
    trim(cm.data->>'Owner Full Name') owner_name,
    lower(trim(cm.data->>'Owner Full Name')) owner_key,
    public.health_nk(cm.data->>'Owner Full Name') owner_nk,
    trim(cm.data->>'Business Name') business_name,
    public.health_biz(cm.data->>'Business Name') biz_norm,
    lower(trim(cm.data->>'Email')) email
  from clients_master cm
  where cm.data->>'col_1' ilike 'live' and coalesce(trim(cm.data->>'Owner Full Name'), '') <> ''
),
ledger as materialized (
  select public.health_date_dmy(l.data->>'Date') dt,
    nullif(regexp_replace(coalesce(l.data->>'Amount', ''), '[^0-9.]', '', 'g'), '')::numeric amt,
    lower(trim(l.data->>'Email')) email,
    public.health_nk(l.data->>'Full Name (On Payment)') n1,
    public.health_nk(l.data->>'Full Name (When Sign Up)') n2
  from ltv_sheet1 l
),
lm as materialized (
  select lv.owner_key, min(g.dt) first_paid,
    -- every dated payment [date, amount]: the app finds a comeback after a long gap
    jsonb_agg(jsonb_build_array(g.dt, g.amt) order by g.dt) filter (where g.dt is not null) ledger_pays
  from live lv
  join ledger g on (g.email <> '' and g.email = lv.email)
                or (lv.owner_nk <> '' and (g.n1 = lv.owner_nk or g.n2 = lv.owner_nk))
  group by 1
),
signed as materialized (
  select lv.owner_key, min(public.health_date_mdy(s.data->>'Signed Date')) signed_at
  from live lv join signed_agreements s on public.health_nk(s.data->>'Full Name') = lv.owner_nk and lv.owner_nk <> ''
  group by 1
),
opp as materialized (
  select o.owner_key, min(o.date_added)::date first_opp
  from ghl_opportunities o where o.owner_key in (select owner_key from live)
  group by 1
),
dep as materialized (
  -- one per person per day (the sheet sometimes writes a payment twice); VOID rows out
  select distinct on (biz_norm, who, dt) biz_norm, dt, amt from (
    select public.health_biz(x.data->>'Business Name') biz_norm,
      public.health_date_dmy(x.data->>'Date') dt,
      coalesce(nullif(lower(trim(x.data->>'Email')), ''), lower(trim(x.data->>'Full Name')), x.id::text) who,
      coalesce(nullif(regexp_replace(coalesce(x.data->>'Amount', ''), '[^0-9.]', '', 'g'), '')::numeric, 50) amt
    from deposits x
    where coalesce(x.data->>'Date', '') !~* 'void' and coalesce(x.data->>'Business Name', '') !~* 'void'
  ) z where dt is not null
),
depc as materialized (
  select lv.owner_key,
    count(*) filter (where dt >= current_date - 14) dep14,
    count(*) filter (where dt >= current_date - 30) dep30,
    count(*) filter (where dt >= current_date - 60 and dt < current_date - 30) dep_prev30,
    -- pay-per-show started 2026-08: from then on the agency keeps the deposit
    coalesce(sum(amt) filter (where dt >= date '2026-08-01'), 0) dep_amt_since_aug,
    array_agg(dt order by dt) dep_dates
  from live lv join dep on dep.biz_norm = lv.biz_norm and lv.biz_norm <> ''
  group by 1
),
refunds as materialized (
  -- [deposit date, amount] per refunded deposit, so the app can count only
  -- the ones inside the client's current stint
  select lv.owner_key,
    jsonb_agg(jsonb_build_array(public.health_date_dmy(r.deposit_date),
      coalesce(nullif(regexp_replace(coalesce(r.amount, ''), '[^0-9.]', '', 'g'), '')::numeric, 50))) refunds
  from live lv join deposit_refunds r on public.health_biz(r.business) = lv.biz_norm and lv.biz_norm <> ''
  where r.status = 'refunded'
  group by 1
),
pt as materialized (
  -- the latest tracking row that actually has a sessions number (blank rows are skipped)
  select distinct on (public.health_nk(p.data->>'Name')) public.health_nk(p.data->>'Name') nk,
    p.data->>'Sessions Done?' sessions, p.data->>'Total Leads' total_leads, p.data->>'Date' checked
  from performance_tracking p
  where coalesce(p.data->>'Name', '') <> '' and coalesce(p.data->>'Sessions Done?', '') ~ '\d'
  order by public.health_nk(p.data->>'Name'), p.sheet_row desc
),
ptprice as materialized (
  select distinct on (public.health_nk(p.data->>'Name')) public.health_nk(p.data->>'Name') nk, p.data->>'What’s the price?' price
  from performance_tracking p where coalesce(p.data->>'What’s the price?', '') ~ '\d'
  order by public.health_nk(p.data->>'Name'), p.sheet_row desc
),
v3p as materialized (
  select distinct on (lower(trim(v.data->>'OWNER/BUSINESS'))) lower(trim(v.data->>'OWNER/BUSINESS')) k, v.data->>'DISCOUNTED PRICE' price
  from v3_pricing v where coalesce(v.data->>'DISCOUNTED PRICE', '') ~ '\d'
  order by lower(trim(v.data->>'OWNER/BUSINESS')), v.sheet_row desc
),
obx as materialized (
  select distinct on (public.health_biz(coalesce(o.config->>'biz', o.client_name)))
    public.health_biz(coalesce(o.config->>'biz', o.client_name)) biz_norm,
    o.config->>'discountedPrice' price, o.status
  from onebox_clients o
  order by public.health_biz(coalesce(o.config->>'biz', o.client_name)), (o.status = 'live') desc, o.updated_at desc
),
po as materialized (
  -- computed once (a plain join re-ran the whole view per client)
  select sheet_row, campaign_status, campaign_paused, daily_budget, l7, l14, l30, cpl7, cpl30, spent7, spent14, spent_all
  from performance_overview
),
hot as materialized (select lower(trim(owner_name)) owner_key, count(*) n from dropped_hot_leads group by 1),
upset as materialized (
  select a.id, a.created_at, a.detail, lower(trim(a.meta->>'contact_name')) owner_key,
    public.health_biz(a.meta->>'business_name') biz_norm
  from alerts a where a.type = 'upset_client' and a.status = 'open'
),
touch as materialized (
  -- a coach's own note; automatic notes and the routine "payment failed" /
  -- "all good" lines (hidden in the activity log too) don't count
  select lower(trim(client_key)) owner_key, max(action_date) last_touch
  from client_activity
  where created_by is not null and coalesce(note, '') !~* 'payment\s*failed|all\s*good'
  group by 1
)
select lv.sheet_row, lv.owner_key, lv.owner_name, lv.business_name, lv.email,
  trim(lv.d->>'Assigned') assigned,
  trim(lv.d->>'Version') version,
  public.health_date_launch(lv.d->>'Launch Call') launch_at,
  public.health_date_mdy(lv.d->>'Agreement') agreement_at,
  sg.signed_at, lm.first_paid, op.first_opp, lm.ledger_pays,
  dc.dep_dates, coalesce(dc.dep14, 0) dep14, coalesce(dc.dep30, 0) dep30, coalesce(dc.dep_prev30, 0) dep_prev30,
  coalesce(dc.dep_amt_since_aug, 0) dep_amt_since_aug,
  rf.refunds,
  pt.sessions, pt.total_leads, pt.checked,
  -- every price we know, best first; the app takes the first one with a real number
  nullif(trim(co.discounted_price), '') price_offer, nullif(trim(ob.price), '') price_funnel,
  nullif(trim(v3p.price), '') price_v3, nullif(trim(lv.d->>'Discounted Price'), '') price_sheet,
  nullif(trim(pp.price), '') price_tracking,
  ob.status onebox_status,
  po.campaign_status, po.campaign_paused, po.daily_budget, po.l7, po.l14, po.l30, po.cpl7, po.cpl30,
  po.spent7, po.spent14, po.spent_all,
  coalesce(h.n, 0) hot_waiting, coalesce(u.n, 0) upset_open, u.latest upset_at, u.note upset_note,
  ck.qualified kill_qualified, ck.dead kill_dead, coalesce(kf.fixed, false) kill_fixed,
  t.last_touch,
  cp.payment_status, cp.usd pay_this_month, cp.notes pay_notes
from live lv
left join lm on lm.owner_key = lv.owner_key
left join signed sg on sg.owner_key = lv.owner_key
left join opp op on op.owner_key = lv.owner_key
left join depc dc on dc.owner_key = lv.owner_key
left join refunds rf on rf.owner_key = lv.owner_key
left join pt on pt.nk = lv.owner_nk
left join ptprice pp on pp.nk = lv.owner_nk
left join client_offers co on co.owner_key = lv.owner_key
left join lateral (select v3p.price from v3p where v3p.k in (lv.owner_key, lower(trim(lv.business_name))) limit 1) v3p on true
left join obx ob on ob.biz_norm = lv.biz_norm and lv.biz_norm <> ''
left join po on po.sheet_row = lv.sheet_row
left join hot h on h.owner_key = lv.owner_key
left join lateral (select count(*) n, max(x.created_at) latest,
    (array_agg(split_part(coalesce(x.detail, ''), E'\n', 1) order by x.created_at desc))[1] note
  from (select distinct on (u.id) u.* from upset u where u.owner_key = lv.owner_key or (u.biz_norm <> '' and u.biz_norm = lv.biz_norm)) x) u on true
left join lateral (select sum(ck.qualified) qualified, sum(ck.dead) dead from call_kill_stats ck where lower(trim(ck.owner_key)) = lv.owner_key) ck on true
left join lateral (select bool_or(kf.fixed) fixed from call_kill_fixes kf where lower(trim(kf.owner_key)) = lv.owner_key) kf on true
left join touch t on t.owner_key = lv.owner_key
left join lateral (select cp.payment_status, cp.usd, cp.notes from client_payments cp
  where cp.owner_key in (public.health_nk(lv.owner_name), lv.owner_key) order by cp.updated_at desc limit 1) cp on true;

revoke all on public.client_health_base from public, anon, authenticated;
