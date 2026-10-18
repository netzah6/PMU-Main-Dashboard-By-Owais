-- Payment Check tab (owner 2026-10-18): each month of the Financing sheet
-- matched against what Square and the dashboard actually charged. The sheet
-- is only READ — these tables hold the owner's Yes / Not paid decisions and
-- a cached copy of each month's match so past months open instantly.
create table if not exists public.payment_checks (
  month text not null,              -- 'YYYY-MM'
  owner_key text not null,          -- normalizeOwnerKey(CLIENT NAME)
  client_name text,
  decision text not null check (decision in ('paid', 'not_paid')),
  suggested text,                   -- what the matcher suggested at the time
  note text,
  decided_by text,
  decided_at timestamptz not null default now(),
  primary key (month, owner_key)
);
alter table public.payment_checks enable row level security;
revoke all on public.payment_checks from anon, authenticated;
grant all on public.payment_checks to service_role;

create table if not exists public.payment_check_cache (
  month text primary key,
  payload jsonb not null,
  built_at timestamptz not null default now()
);
alter table public.payment_check_cache enable row level security;
revoke all on public.payment_check_cache from anon, authenticated;
grant all on public.payment_check_cache to service_role;
