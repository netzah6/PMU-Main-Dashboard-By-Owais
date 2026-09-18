-- One row per sheet-mirror table: when the sync last ran and what it did.
-- Needed since PR #632 (sync writes only changed rows, so max(synced_at)
-- no longer says "the sync ran"). data_freshness now prefers this table
-- and falls back to max(synced_at). Applied to production 2026-09-18.
create table if not exists public.sheet_sync_runs (
  table_name text primary key,
  ran_at timestamptz not null default now(),
  sheet_rows integer,
  rows_written integer,
  rows_unchanged integer,
  status text,
  error text
);
alter table public.sheet_sync_runs enable row level security;
drop policy if exists "Authenticated read" on public.sheet_sync_runs;
create policy "Authenticated read" on public.sheet_sync_runs for select to authenticated using (true);

create or replace view public.data_freshness as
  select k.key, coalesce(r.ran_at, m.synced_at) as synced_at
  from (values ('cpl','cpl_7days'), ('cpl_7days','cpl_7days'), ('cpl_14days','cpl_14days'), ('cpl_30days','cpl_30days'), ('campaign_spent','campaign_spent')) as k(key, table_name)
  left join public.sheet_sync_runs r on r.table_name = k.table_name and r.status = 'ok'
  left join (
    select 'cpl_7days' t, max(synced_at) synced_at from public.cpl_7days
    union all select 'cpl_14days', max(synced_at) from public.cpl_14days
    union all select 'cpl_30days', max(synced_at) from public.cpl_30days
    union all select 'campaign_spent', max(synced_at) from public.campaign_spent
  ) m on m.t = k.table_name;
