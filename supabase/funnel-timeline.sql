-- Funnel timeline (owner, 11/04/2026): every funnel's page and settings are saved
-- when they change, next to its booking and deposit rates, so a page can be put
-- back later. Already applied to production. See src/lib/funnel-timeline.ts.
--   funnel_versions   one row each time something on a funnel changes
--   funnel_notes      notes for what we can't read (AI, ads); slug null = all funnels

create table if not exists public.funnel_versions (
  id bigserial primary key,
  slug text not null references public.onebox_clients(slug) on delete cascade,
  saved_at timestamptz not null default now(),
  engine integer not null,
  frozen boolean not null default false,
  page jsonb not null,
  fingerprint jsonb not null,
  changes jsonb not null default '[]'::jsonb
);
create index if not exists funnel_versions_slug_saved on public.funnel_versions (slug, saved_at desc);
alter table public.funnel_versions enable row level security;

create table if not exists public.funnel_notes (
  id bigserial primary key,
  slug text references public.onebox_clients(slug) on delete cascade,
  at timestamptz not null default now(),
  note text not null,
  by text
);
create index if not exists funnel_notes_slug_at on public.funnel_notes (slug, at desc);
alter table public.funnel_notes enable row level security;

create or replace function public.funnel_latest_versions()
returns table (slug text, id bigint, saved_at timestamptz, engine integer, frozen boolean, fingerprint jsonb, changes jsonb)
language sql stable set search_path = public as $$
  select distinct on (v.slug) v.slug, v.id, v.saved_at, v.engine, v.frozen, v.fingerprint, v.changes
  from funnel_versions v order by v.slug, v.saved_at desc, v.id desc
$$;

-- Leads, people who picked a time, and deposits per funnel per Pacific day, one
-- row per funnel (a row per day would hit the API's 1,000-row cap within a week).
-- Same counting as funnel_freeze_stats in funnel-freeze.sql.
create or replace function public.funnel_timeline_daily(p_since date)
returns table (
  slug text, client_name text, status text, template text, free_booking boolean,
  frozen_engine integer, frozen_at timestamptz,
  business text, owner_name text, client_status text, days jsonb
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
  ), pf as (
    select o.slug, coalesce(nullif(right(regexp_replace(coalesce(o.phone, ''), '\D', '', 'g'), 10), ''), o.id::text) who,
      min((o.picked_time_at at time zone 'America/Los_Angeles')::date) d
    from onebox_leads o where o.picked_time_at >= p_since::timestamp - interval '1 day'
    group by 1, 2
  ), per as (
    select oc.slug, al.k from onebox_clients oc left join alias al on al.a = freeze_norm(oc.client_name)
  ), u as (
    select p.slug, lf.d, 1 l, 0 pk, 0 dp from per p join lf on lf.k = p.k where lf.d >= p_since
    union all select p.slug, df.d, 0, 0, 1 from per p join df on df.k = p.k where df.d >= p_since
    union all select pf.slug, pf.d, 0, 1, 0 from pf where pf.d >= p_since
  ), g as (
    select u.slug, u.d, sum(u.l)::int l, sum(u.pk)::int p, sum(u.dp)::int n from u group by 1, 2
  ), j as (
    select g.slug, jsonb_object_agg(to_char(g.d, 'YYYY-MM-DD'), jsonb_build_object('l', g.l, 'p', g.p, 'd', g.n)) days from g group by 1
  )
  select oc.slug, oc.client_name, oc.status, oc.extras->>'template', coalesce(oc.extras->>'freeBooking', '') in ('true', '1'),
    oc.frozen_engine, oc.frozen_at, cm.biz, cm.owner_name, cm.st, coalesce(j.days, '{}'::jsonb)
  from onebox_clients oc
  left join alias al on al.a = freeze_norm(oc.client_name)
  left join cm on cm.k = al.k
  left join j on j.slug = oc.slug
$$;

revoke all on function public.funnel_latest_versions() from public, anon, authenticated;
revoke all on function public.funnel_timeline_daily(date) from public, anon, authenticated;
grant execute on function public.funnel_latest_versions() to service_role;
grant execute on function public.funnel_timeline_daily(date) to service_role;
