-- Power dialer log (owner 11/15/2026: "keep track of everything she's doing —
-- what time she calls, and if the system works properly"). One row per lead
-- the dashboard put into a caller's GHL Power Dialer workflow, with the text
-- written for the no-answer SMS, so the activity view can match the calls and
-- the text GHL logged afterwards. Service role only (the API reads it).
create table if not exists public.dialer_sends (
  id bigint generated always as identity primary key,
  contact_id text not null,
  contact_name text,
  phone text,
  list text,
  caller_id text not null,
  caller_name text,
  sent_by text,
  sms_text text,
  sent_at timestamptz not null default now()
);
create index if not exists dialer_sends_caller_sent on public.dialer_sends (caller_id, sent_at desc);
alter table public.dialer_sends enable row level security;
