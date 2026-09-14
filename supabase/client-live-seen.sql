-- Which clients have been seen LIVE by the alerts scan, and since when.
-- Seeded on the first run (baseline = true, never alerted); owners that turn
-- Live afterwards are checked for a signed agreement (Standard program only).
create table if not exists client_live_seen (
  owner_key text primary key,
  owner_name text,
  first_seen_live_at timestamptz not null default now(),
  baseline boolean not null default false
);
