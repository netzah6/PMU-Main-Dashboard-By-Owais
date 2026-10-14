-- Sales tab: real follow-up tracking from the agency account's GHL call /
-- text log (replaces the hand-typed "Follow up 1/2/3" sheet columns, which
-- the team does not fill in). One row per lead on the to-do lists.
-- Owner's rule (2026-10-14): a follow-up = a call that lasted 30 s or more,
-- OR two call attempts in a row plus a text message.
create table if not exists public.sales_followups (
  name_key     text primary key,            -- normalised lead name (sales-board norm())
  name         text not null,
  contact_id   text,                        -- GHL contact in the agency sub-account
  contact_name text,
  since        timestamptz,                 -- only activity after this counts
  follow_ups   integer not null default 0,
  events       jsonb not null default '[]'::jsonb,  -- [{at, kind, detail}]
  last_at      timestamptz,
  error        text,
  synced_at    timestamptz not null default now()
);
alter table public.sales_followups enable row level security;
-- Service role only (the dashboard API reads it); no policies for anon/authenticated.
