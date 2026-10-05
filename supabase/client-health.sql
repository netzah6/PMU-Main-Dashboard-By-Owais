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

-- Date helpers: plpgsql (cached plans) with NO exception blocks — EXCEPTION
-- blocks are subtransactions, which can't run in parallel workers, and a
-- parallel scan (materialized-view refresh) silently lost dates.
create or replace function public.health_date_parts(a int, b int, y int, day_first boolean) returns date
language plpgsql immutable parallel safe set search_path = '' as $$
declare mo int; dd int;
begin
  if day_first then mo := b; dd := a; else mo := a; dd := b; end if;
  if y is null or mo is null or dd is null or y < 2015 or y > 2100 or mo < 1 or mo > 12 or dd < 1 then return null; end if;
  if dd > pg_catalog.date_part('day', pg_catalog.make_date(y, mo, 1) + interval '1 month' - interval '1 day')::int then return null; end if;
  return pg_catalog.make_date(y, mo, dd);
end $$;

-- DD/MM/YYYY (or ISO) → date; anything else → null.
create or replace function public.health_date_dmy(t text) returns date
language plpgsql immutable parallel safe set search_path = '' as $$
declare m text[];
begin
  t := pg_catalog.btrim(coalesce(t, ''));
  m := pg_catalog.regexp_match(t, '^([0-9]{1,2})/([0-9]{1,2})/([0-9]{4})');
  if m is not null then return public.health_date_parts(m[1]::int, m[2]::int, m[3]::int, true); end if;
  m := pg_catalog.regexp_match(t, '^([0-9]{4})-([0-9]{2})-([0-9]{2})');
  if m is not null then return public.health_date_parts(m[3]::int, m[2]::int, m[1]::int, true); end if;
  return null;
end $$;

-- MM/DD/YYYY (or ISO) → date.
create or replace function public.health_date_mdy(t text) returns date
language plpgsql immutable parallel safe set search_path = '' as $$
declare m text[];
begin
  t := pg_catalog.btrim(coalesce(t, ''));
  m := pg_catalog.regexp_match(t, '^([0-9]{1,2})/([0-9]{1,2})/([0-9]{4})');
  if m is not null then return public.health_date_parts(m[1]::int, m[2]::int, m[3]::int, false); end if;
  m := pg_catalog.regexp_match(t, '^([0-9]{4})-([0-9]{2})-([0-9]{2})');
  if m is not null then return public.health_date_parts(m[3]::int, m[2]::int, m[1]::int, true); end if;
  return null;
end $$;

-- Launch Call: "Friday, April 17, 2026 11:00" → 2026-04-17; DD/MM/YYYY falls through.
create or replace function public.health_date_launch(t text) returns date
language plpgsql immutable parallel safe set search_path = '' as $$
declare m text[];
begin
  m := pg_catalog.regexp_match(coalesce(t, ''), '([A-Za-z]+) ([0-9]{1,2}), ([0-9]{4})');
  if m is not null then
    return public.health_date_parts(m[2]::int,
      pg_catalog.array_position(array['january','february','march','april','may','june','july','august','september','october','november','december'], pg_catalog.lower(m[1])),
      m[3]::int, true);
  end if;
  return public.health_date_dmy(t);
end $$;

revoke execute on function public.health_nk(text), public.health_biz(text), public.health_date_parts(int, int, int, boolean),
  public.health_date_dmy(text), public.health_date_mdy(text), public.health_date_launch(text) from public, anon, authenticated;
-- the view calls them as the querying role (the app's service role)
grant execute on function public.health_nk(text), public.health_biz(text), public.health_date_parts(int, int, int, boolean),
  public.health_date_dmy(text), public.health_date_mdy(text), public.health_date_launch(text) to service_role;

-- ── Pre-rolled lead / booking counts (the raw tables are too big to scan on
-- every page load). Refreshed by pg_cron.

-- GHL opportunities per client per month — the only lead history before the
-- leads sheet started (2026-04-27). Team test leads and CSV/manual imports out.
drop materialized view if exists public.health_opp_months cascade;
create materialized view public.health_opp_months as
select o.owner_key, date_trunc('month', o.date_added)::date m,
  count(distinct o.contact_id) leads, array_agg(distinct o.date_added::date order by o.date_added::date) days
from ghl_opportunities o
where coalesce(o.owner_key, '') <> '' and o.date_added is not null
  and coalesce(o.name, '') !~* '\mtest'
  and not (coalesce(o.raw->'attributions', '[]'::jsonb) @> '[{"medium":"csv_import"}]'
        or coalesce(o.raw->'attributions', '[]'::jsonb) @> '[{"medium":"manual"}]')
group by 1, 2;
create unique index if not exists health_opp_months_key on public.health_opp_months (owner_key, m);

-- Leads sheet + bookings per business per day. Leads: one per person per
-- business per MONTH (the one-box writes a lead twice, 10-digit and
-- 1+10-digit phone); bookings: one per person per business, on the day they
-- first booked (bookings fire again on every confirm / reschedule).
drop materialized view if exists public.health_biz_days cascade;
create materialized view public.health_biz_days as
with lm as (
  select public.health_biz(l.data->>'Business Name') b,
    coalesce(public.health_date_dmy(l.data->>'col_6'), public.health_date_dmy(l.data->>'Date')) d,
    coalesce(nullif(right(regexp_replace(coalesce(l.data->>'Phone Number', ''), '\D', '', 'g'), 10), ''),
             nullif(lower(trim(l.data->>'Email')), ''), nullif(lower(trim(l.data->>'Full Name')), ''), l.id::text) who
  from leads_master l
  where coalesce(l.data->>'Full Name', '') !~* '\mtest'
), lf as (select b, who, min(d) d from lm where d is not null and b <> '' group by b, who, date_trunc('month', d)),
bk as (
  select public.health_biz(x.data->>'Business Name') b,
    coalesce(public.health_date_dmy(x.data->>'col_6'), public.health_date_dmy(x.data->>'Date')) d,
    coalesce(nullif(right(regexp_replace(coalesce(x.data->>'Phone Number', ''), '\D', '', 'g'), 10), ''),
             nullif(lower(trim(x.data->>'Email')), ''), nullif(lower(trim(x.data->>'Full Name')), ''), x.id::text) who
  from bookings x
), bf as (select b, who, min(d) d from bk where d is not null and b <> '' group by 1, 2)
select b biz_norm, d, sum(leads)::int leads, sum(bookings)::int bookings from (
  select b, d, count(*) leads, 0 bookings from lf group by 1, 2
  union all
  select b, d, 0, count(*) from bf group by 1, 2
) z group by 1, 2;
create unique index if not exists health_biz_days_key on public.health_biz_days (biz_norm, d);

revoke all on public.health_opp_months, public.health_biz_days from public, anon, authenticated;
grant select on public.health_opp_months, public.health_biz_days to service_role;

-- (pg_cron, scheduled once)
-- select cron.schedule('refresh-health-biz-days', '*/15 * * * *', 'refresh materialized view concurrently public.health_biz_days');
-- select cron.schedule('refresh-health-opp-months', '7 * * * *', 'refresh materialized view concurrently public.health_opp_months');

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
om as materialized (
  -- [month, leads, [lead days]] per month from GHL opportunities
  select o.owner_key, jsonb_agg(jsonb_build_array(o.m, o.leads, to_jsonb(o.days)) order by o.m) opp_months
  from health_opp_months o where o.owner_key in (select owner_key from live) group by 1
),
bd as materialized (
  -- leads sheet + bookings: [month, leads, bookings] (bookings are only
  -- trustworthy from 2026-07-30 — the sheet bulk-dumped history on 06-24 and
  -- 07-29), plus the deduped 7/30-day counts
  select lv.owner_key,
    jsonb_agg(jsonb_build_array(x.m, x.leads, x.bookings) order by x.m) biz_months,
    sum(x.l7) leads7, sum(x.l30) leads30, sum(x.b30) bookings30, min(x.first_lead) first_sheet_lead
  from live lv join (
    select biz_norm, date_trunc('month', d)::date m, sum(leads) leads,
      coalesce(sum(bookings) filter (where d >= date '2026-07-30'), 0) bookings,
      coalesce(sum(leads) filter (where d > current_date - 7), 0) l7,
      coalesce(sum(leads) filter (where d > current_date - 30), 0) l30,
      coalesce(sum(bookings) filter (where d > current_date - 30 and d >= date '2026-07-30'), 0) b30,
      min(d) filter (where leads > 0) first_lead
    from health_biz_days group by 1, 2
  ) x on x.biz_norm = lv.biz_norm and lv.biz_norm <> ''
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
    count(*) filter (where dt > current_date - 14) dep14,
    count(*) filter (where dt > current_date - 30) dep30,
    count(*) filter (where dt > current_date - 60 and dt <= current_date - 30) dep_prev30,
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
  select sheet_row, campaign_status, campaign_paused, daily_budget, l3, l7, l14, l30, cpl7, cpl30, spent7, spent14, spent_all
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
  sg.signed_at, lm.first_paid, lm.ledger_pays,
  om.opp_months, bd.biz_months, coalesce(bd.leads7, 0) leads7, coalesce(bd.leads30, 0) leads30,
  coalesce(bd.bookings30, 0) bookings30, bd.first_sheet_lead,
  nullif(trim(lv.d->>'Ad Spent'), '') ad_plan,
  dc.dep_dates, coalesce(dc.dep14, 0) dep14, coalesce(dc.dep30, 0) dep30, coalesce(dc.dep_prev30, 0) dep_prev30,
  coalesce(dc.dep_amt_since_aug, 0) dep_amt_since_aug,
  rf.refunds,
  pt.sessions, pt.total_leads, pt.checked,
  -- every price we know, best first; the app takes the first one with a real number
  nullif(trim(co.discounted_price), '') price_offer, nullif(trim(ob.price), '') price_funnel,
  nullif(trim(v3p.price), '') price_v3, nullif(trim(lv.d->>'Discounted Price'), '') price_sheet,
  nullif(trim(pp.price), '') price_tracking,
  ob.status onebox_status,
  po.campaign_status, po.campaign_paused, po.daily_budget, po.l3 raw_l3, po.l7, po.l14, po.l30, po.cpl7, po.cpl30,
  po.spent7, po.spent14, po.spent_all,
  coalesce(h.n, 0) hot_waiting, coalesce(u.n, 0) upset_open, u.latest upset_at, u.note upset_note,
  ck.qualified kill_qualified, ck.dead kill_dead, coalesce(kf.fixed, false) kill_fixed,
  t.last_touch,
  cp.payment_status, cp.usd pay_this_month
from live lv
left join lm on lm.owner_key = lv.owner_key
left join signed sg on sg.owner_key = lv.owner_key
left join om on om.owner_key = lv.owner_key
left join bd on bd.owner_key = lv.owner_key
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
left join lateral (select cp.payment_status, cp.usd from client_payments cp
  where cp.owner_key in (public.health_nk(lv.owner_name), lv.owner_key) order by cp.updated_at desc limit 1) cp on true;

revoke all on public.client_health_base from public, anon, authenticated;
