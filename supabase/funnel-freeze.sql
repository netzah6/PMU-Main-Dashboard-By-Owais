-- Funnel freeze (owner, 11/04/2026): click a client's funnel to keep its page
-- design and built-in wording as they are, click again to undo. Already applied
-- to production.
--   onebox_clients.frozen_engine  the engine version this funnel stays on (null = not frozen)
--   onebox_clients.frozen_at      since when
--   onebox_clients.frozen_page    everything visitors saw at the click (config, FAQs, checkout block)
--   onebox_engine_copies          saved engine files, one per version, written on the first freeze
--   funnel_freeze                 suggestion + freeze history for the Freeze screen

alter table public.onebox_clients
  add column if not exists frozen_engine integer,
  add column if not exists frozen_at timestamptz,
  add column if not exists frozen_page jsonb;

create table if not exists public.onebox_engine_copies (
  version integer primary key,
  body text not null,
  sha256 text not null,
  created_at timestamptz not null default now()
);
alter table public.onebox_engine_copies enable row level security;

create table if not exists public.funnel_freeze (
  slug text primary key references public.onebox_clients(slug) on delete cascade,
  suggested_at timestamptz,
  suggested_leads integer,
  suggested_deposits integer,
  declined_at timestamptz,
  declined_by text,
  declined_note text,
  frozen_by text,
  frozen_leads integer,
  frozen_deposits integer,
  history jsonb not null default '[]'::jsonb,
  last_frozen jsonb, -- the page kept until the last Unfreeze, so a misclick can be restored
  updated_at timestamptz not null default now()
);
alter table public.funnel_freeze enable row level security;

create or replace function public.freeze_norm(x text) returns text
language sql immutable as $$
  select regexp_replace(
    regexp_replace(translate(lower(coalesce(x, '')), 'áàâäãéèêëíìîïóòôöõúùûüñç', 'aaaaaeeeeiiiiooooouuuunc'), '\s*-\s*ad account\s*$', ''),
    '[^a-z0-9]', '', 'g')
$$;

-- Sheet dates are DD/MM/YYYY or ISO; anything else is no date.
-- One plain CASE, not a CTE: Postgres can only inline it that way (24 s vs 2 s).
create or replace function public.freeze_date(x text) returns date
language sql immutable as $$
  select case
    when x ~ '^\d{1,2}/\d{1,2}/\d{4}$' and split_part(x, '/', 3)::int >= 2000 and split_part(x, '/', 2)::int between 1 and 12 and split_part(x, '/', 1)::int between 1 and 31
      then make_date(split_part(x, '/', 3)::int, split_part(x, '/', 2)::int, 1) + (split_part(x, '/', 1)::int - 1)
    when x ~ '^\d{4}-\d{2}-\d{2}' and left(x, 4)::int >= 2000 and substr(x, 6, 2)::int between 1 and 12 and substr(x, 9, 2)::int between 1 and 31
      then make_date(left(x, 4)::int, substr(x, 6, 2)::int, 1) + (substr(x, 9, 2)::int - 1)
  end
$$;

-- One row per funnel: deposits and leads by month, the period before 08/24/2026,
-- last 30 days. Same counting as the 11/04 study: leads = first time a phone
-- (else email, else name) shows up for that client, from 04/27/2026 (the leads
-- sheet starts there); deposits = first per email (else name), no $1 tests.
-- Names match exactly, then by a unique prefix of 8+ characters (same rule as
-- findClientProgram). Days run on Pacific time, like the sheet.
drop function if exists public.funnel_freeze_stats();
create function public.funnel_freeze_stats()
returns table (
  slug text, client_name text, status text, template text, free_booking boolean, deposit_url text,
  frozen_engine integer, frozen_at timestamptz,
  business text, owner_name text, client_status text, months jsonb,
  before_leads integer, before_deposits integer, leads30 integer, deposits30 integer,
  picks30 integer, page_leads30 integer, last_lead date
)
language sql stable set search_path = public as $$
  with today as (
    select (now() at time zone 'America/Los_Angeles')::date d
  ), cm as (
    select distinct on (k) k, biz, owner_name, st, ad from (
      select freeze_norm(data->>'Business Name') k, data->>'Business Name' biz, trim(data->>'Owner Full Name') owner_name,
        lower(coalesce(data->>'col_1', '')) st,
        coalesce(nullif(data->>'Ad account Name', ''), nullif(data->>'Ad Account Name', '')) ad, sheet_row
      from clients_master where coalesce(data->>'Business Name', '') <> ''
    ) z order by k, (st = 'live') desc, sheet_row desc
  ), exact_name as (
    select distinct on (a) a, k from (
      select k a, k, 0 pr, st from cm
      union all select freeze_norm(ad), k, 1, st from cm where freeze_norm(ad) <> ''
    ) y where a <> '' order by a, pr, (st = 'live') desc
  ), names as (
    select distinct freeze_norm(data->>'Business Name') a from leads_master
    union select freeze_norm(data->>'Business Name') from deposits
    union select freeze_norm(client_name) from onebox_clients
  ), prefix_name as (
    select n.a, min(c.k) k
    from names n join cm c on length(n.a) >= 8 and length(c.k) >= 8 and (c.k like n.a || '%' or n.a like c.k || '%')
    where not exists (select 1 from exact_name e where e.a = n.a)
    group by n.a having count(distinct c.k) = 1
  ), alias as (
    select a, k from exact_name union all select a, k from prefix_name
  ), lf as (
    select al.k, x.who, min(x.d) d from (
      select freeze_norm(data->>'Business Name') a,
        coalesce(nullif(right(regexp_replace(coalesce(data->>'Phone Number', ''), '\D', '', 'g'), 10), ''),
                 nullif(lower(trim(data->>'Email')), ''), nullif(lower(trim(data->>'Full Name')), '')) who,
        coalesce(freeze_date(data->>'col_6'), freeze_date(data->>'Date')) d
      from leads_master
    ) x join alias al on al.a = x.a
    where x.who is not null and x.d >= date '2026-04-27' and x.d <= (select d from today)
    group by 1, 2
  ), df as (
    select al.k, x.who, min(x.d) d from (
      select freeze_norm(data->>'Business Name') a,
        coalesce(nullif(lower(trim(data->>'Email')), ''), nullif(lower(trim(data->>'Full Name')), '')) who,
        freeze_date(data->>'Date') d
      from deposits
      where coalesce(trim(data->>'Amount'), '') not in ('$1', '1', '$1.00')
        and coalesce(data->>'Email', '') !~* '((^|[._+-])test[0-9]*@|^asd@|@test\.|netzach|netzah|mizrahi)'
        and coalesce(data->>'Full Name', '') !~* '(\mtest\M|netza|mizrahi)'
    ) x join alias al on al.a = x.a
    where x.who is not null and x.d >= date '2026-04-27' and x.d <= (select d from today)
    group by 1, 2
  ), mm as (
    select k, m, sum(l)::int l, sum(n)::int n from (
      select k, to_char(d, 'YYYY-MM') m, count(*) l, 0 n from lf group by 1, 2
      union all select k, to_char(d, 'YYYY-MM'), 0, count(*) from df group by 1, 2
    ) u group by 1, 2
  ), mj as (
    select k, jsonb_object_agg(m, jsonb_build_object('l', l, 'd', n)) months from mm group by 1
  ), ls as (
    select k,
      count(*) filter (where d < date '2026-08-24')::int before_leads,
      count(*) filter (where d > (select d from today) - 30)::int leads30,
      max(d) last_lead
    from lf group by 1
  ), ds as (
    select k,
      count(*) filter (where d < date '2026-08-24')::int before_deposits,
      count(*) filter (where d > (select d from today) - 30)::int deposits30
    from df group by 1
  ), pk as (
    select ol.slug,
      count(distinct ol.who) filter (where ol.picked > (select d from today) - 30)::int picks30,
      count(distinct ol.who) filter (where ol.came > (select d from today) - 30)::int page_leads30
    from (
      select o.slug, (o.picked_time_at at time zone 'America/Los_Angeles')::date picked, (o.created_at at time zone 'America/Los_Angeles')::date came,
        coalesce(nullif(right(regexp_replace(coalesce(o.phone, ''), '\D', '', 'g'), 10), ''), o.id::text) who
      from onebox_leads o
      where o.created_at >= now() - interval '32 days' or o.picked_time_at >= now() - interval '32 days'
    ) ol group by 1
  )
  select oc.slug, oc.client_name, oc.status, oc.extras->>'template', coalesce(oc.extras->>'freeBooking', '') in ('true', '1'), oc.config->>'depositFunnelUrl',
    oc.frozen_engine, oc.frozen_at,
    cm.biz, cm.owner_name, cm.st, coalesce(mj.months, '{}'::jsonb),
    coalesce(ls.before_leads, 0), coalesce(ds.before_deposits, 0), coalesce(ls.leads30, 0), coalesce(ds.deposits30, 0),
    coalesce(pk.picks30, 0), coalesce(pk.page_leads30, 0), ls.last_lead
  from onebox_clients oc
  left join alias al on al.a = freeze_norm(oc.client_name)
  left join cm on cm.k = al.k
  left join mj on mj.k = al.k
  left join ls on ls.k = al.k
  left join ds on ds.k = al.k
  left join pk on pk.slug = oc.slug
$$;

revoke all on function public.funnel_freeze_stats() from public, anon, authenticated;
revoke all on function public.freeze_norm(text) from public, anon, authenticated;
revoke all on function public.freeze_date(text) from public, anon, authenticated;
grant execute on function public.funnel_freeze_stats() to service_role;
grant execute on function public.freeze_norm(text) to service_role;
grant execute on function public.freeze_date(text) to service_role;

-- Owner, 11/04/2026: leave browology+ out of any freeze suggestion.
insert into public.funnel_freeze (slug, declined_at, declined_by, declined_note)
values ('browology', now(), 'owner', 'Owner 11/04: leave as is, doing fine')
on conflict (slug) do nothing;
