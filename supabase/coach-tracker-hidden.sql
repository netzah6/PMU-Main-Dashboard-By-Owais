-- Coaches hidden from the Coach Tracker board (admin toggle).
-- Managed server-side only by /api/sales/coaches via the service-role key.
create table if not exists public.coach_tracker_hidden (
  coach text primary key,
  hidden_by text,
  hidden_at timestamptz not null default now()
);
-- Server-only: service-role bypasses RLS, so no policies are needed. Without
-- this the table is fully readable/writable with the public anon key
-- (Supabase rls_disabled_in_public advisor, 2026-09-22).
alter table public.coach_tracker_hidden enable row level security;
