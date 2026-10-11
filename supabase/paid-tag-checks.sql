-- Paid-deposit safety net (owner, 2026-10-11 — Savannah Stidham / Eye Select
-- Beauty: paid $50, but the payment never reached her GHL contact, so the
-- "fanbasis buyer" tag never landed and her appointment went INVALID).
-- One row per deposit checked, so each payment is healed at most once.
create table if not exists public.paid_tag_checks (
  key text primary key,            -- email|business|date
  location_id text,
  contact_id text,
  result text not null,            -- ok | healed | not_found | no_location
  attempts int not null default 1,
  checked_at timestamptz not null default now()
);
alter table public.paid_tag_checks enable row level security;
