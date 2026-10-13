-- Server-side Meta Conversions API send log (owner, 2026-10-13): one row per
-- attempted Lead/Purchase send or skip, so the Funnels tab can prove Purchase
-- tracking is flowing per funnel and name the reason when it isn't (no token,
-- no pixel, Meta rejected). Applied to the live project 2026-10-13.
create table if not exists public.capi_events (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  slug text not null,
  event_name text not null,
  event_id text,
  pixel_id text,
  ok boolean not null default false,
  error text,
  lead_phone text
);
create index if not exists capi_events_created_idx on public.capi_events (created_at desc);
create index if not exists capi_events_slug_idx on public.capi_events (slug, created_at desc);
alter table public.capi_events enable row level security;
-- service role only (no policies) — the dashboard reads through the server.
