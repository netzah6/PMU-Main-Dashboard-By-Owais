-- Closer commission tracking (Sales tab → closer view → Payment plans).
-- One row per (client, month) installment the commission was requested /
-- paid for; the payments themselves come live from the Financing sheet.
-- Already applied to production 2026-09-16.
create table if not exists public.closer_commissions (
  client_key text not null,
  ym text not null,
  closer text not null,
  client_name text not null,
  amount numeric,
  requested_at timestamptz,
  requested_by text,
  paid_at timestamptz,
  paid_by text,
  updated_at timestamptz not null default now(),
  primary key (client_key, ym)
);
alter table public.closer_commissions enable row level security;
drop policy if exists "Authenticated read" on public.closer_commissions;
create policy "Authenticated read" on public.closer_commissions for select to authenticated using (true);
