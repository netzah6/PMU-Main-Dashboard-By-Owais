-- One row per lead for the Meta "RealClient" event (owner, 11/20/2026):
-- the first time a lead reaches Deposit Collected / Session Done / 5-star in
-- the artist's GHL pipeline, one event is sent to the funnel's dataset.
-- This log keeps it to once per lead, forever (Meta only dedupes for 48 h).
-- status: seeded (already a client when the account was first seen — not
-- sent), sent, retry (Meta hiccup, tried again next hour), failed (refused /
-- no pixel — final), skipped (moved more than 7 days ago; Meta won't take it).
-- contact_id '*' marks an account as seeded.
create table if not exists public.stage_conversions (
  location_id text not null,
  contact_id text not null,
  slug text,
  stage text,
  stage_at timestamptz,
  status text not null,
  event_id text,
  error text,
  note text,
  attempts int not null default 0,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (location_id, contact_id)
);
create index if not exists stage_conversions_status_idx on public.stage_conversions (status, stage_at desc);
alter table public.stage_conversions enable row level security;
-- service role only (no policies) — read through the server.
