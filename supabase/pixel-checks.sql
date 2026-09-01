-- Pixel Checking tab: per-client funnel pixel/conversion audit, one row per sub-account.
-- Applied to production 2026-09-01. Seeded from the 2026-08-31 full-roster audit.
-- pages: ordered array of {position, role, path, url, pixels[], events{name:count}, dead{name:count}, sched_snippet, extra}
-- checks: {pv1|lead2|sched3|purchase4: {ok, detail}} against the desired structure:
--   PageView on page 1, Lead on page 2, Schedule on page 3, Purchase on page 4.
create table if not exists public.pixel_checks (
  location_id text primary key,
  business_name text not null,
  owner_name text,
  funnel_name text,
  funnel_id text,
  entry_url text,
  pixel_ids text[] not null default '{}',
  pages jsonb not null default '[]',
  checks jsonb not null default '{}',
  status text not null default 'unresolved', -- ok | issues | blocked | unresolved
  notes text,
  audited_at timestamptz not null default now()
);

alter table public.pixel_checks enable row level security;

drop policy if exists "pixel_checks_read" on public.pixel_checks;
create policy "pixel_checks_read" on public.pixel_checks
  for select to authenticated using (true);
