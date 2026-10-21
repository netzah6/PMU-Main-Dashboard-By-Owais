-- Source health of a mirrored sheet tab (10/21/2026): the SyncWith report in
-- the Facebook Campaign Stats workbook can be PAUSED ("Report paused:
-- Unexpected failure" in row 1) while our pull still succeeds, so the badge
-- showed green on stale numbers. The sync now records what it saw in the
-- banner, plus when the tab's numbers last actually changed.
alter table public.sheet_sync_runs add column if not exists source_status text;      -- 'ok' | 'paused' | null
alter table public.sheet_sync_runs add column if not exists source_note text;         -- the banner text
alter table public.sheet_sync_runs add column if not exists data_changed_at timestamptz; -- last run that wrote rows

create or replace view public.data_freshness as
  select k.key, coalesce(r.ran_at, m.synced_at) as synced_at,
         r.source_status, r.source_note, r.data_changed_at
  from (values ('cpl','cpl_7days'), ('cpl_7days','cpl_7days'), ('cpl_14days','cpl_14days'), ('cpl_30days','cpl_30days'), ('campaign_spent','campaign_spent')) as k(key, table_name)
  left join public.sheet_sync_runs r on r.table_name = k.table_name and r.status = 'ok'
  left join (
    select 'cpl_7days' t, max(synced_at) synced_at from public.cpl_7days
    union all select 'cpl_14days', max(synced_at) from public.cpl_14days
    union all select 'cpl_30days', max(synced_at) from public.cpl_30days
    union all select 'campaign_spent', max(synced_at) from public.campaign_spent
  ) m on m.t = k.table_name;
