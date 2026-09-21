-- Coach Report tab (2026-09-21): the monthly "Managed Accounts Accountability
-- Report" the coaches used to file through a GHL form, now submitted from the
-- dashboard. One row per submission; `entries` holds the coach's per-client
-- classification and `mismatches` what disagreed with the dashboard at submit
-- time (also mirrored into an alerts row for the admin's Alerts tab).
-- Applied to production (rtmiakhhohhfaqghieri) 2026-09-21.
create table if not exists public.coach_reports (
  id bigint generated always as identity primary key,
  coach text not null,
  coach_email text not null default '',
  report_month date not null,                     -- first day of the month the report covers
  snapshot_date date,                             -- the 20th snapshot the month is paid from (null if not taken yet)
  entries jsonb not null,                         -- [{owner, biz, reported: "active"|"paused_resuming"|"churned"}]
  extra text not null default '',                 -- free-text notes / clients not on the list
  mismatches jsonb not null default '[]'::jsonb,  -- computed at submit time vs clients_master
  created_at timestamptz not null default now()
);
alter table public.coach_reports enable row level security;
drop policy if exists coach_reports_read on public.coach_reports;
create policy coach_reports_read on public.coach_reports for select to authenticated using (true);
