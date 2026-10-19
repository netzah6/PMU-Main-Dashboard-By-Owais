-- Win-back: former clients we are trying to bring back (owner, 2026-10-10).
-- Source of truth = the "Follow up To PPS" Google Sheet: rows marked
-- "Follow Up" are synced here (AI tab → 🔁 Win-back → Sync from sheet), their
-- PMU Bookings On Demand contact gets the WINBACK_TAG, and the Program column
-- decides which offer the AI drafts may pitch. Nothing here sends a message.
create table if not exists public.winback_contacts (
  sheet_row int primary key,              -- the sheet's "#" column
  owner_name text not null,
  business text,
  phone text,
  email text,
  last_paid text,
  offer text check (offer in ('pps', 'monthly')), -- null = not approved yet → AI never pitches
  contact_id text,                        -- PMU Bookings On Demand contact (null = not found)
  match_note text,                        -- why it didn't match / what was matched on
  tagged_at timestamptz,
  active boolean not null default true,   -- false once the sheet flips the row to "Not"
  outcome text check (outcome in ('won', 'lost')),
  synced_at timestamptz not null default now()
);
create index if not exists winback_contacts_contact_idx on public.winback_contacts (contact_id);

alter table public.winback_contacts enable row level security;
-- No policies: only the service role (admin-gated API routes) reads or writes.

-- Chat review before tagging (owner, 2026-10-10): did we end on bad terms?
alter table public.winback_contacts add column if not exists review_verdict text check (review_verdict in ('ok', 'tense', 'bad', 'opted_out', 'no_chat'));
alter table public.winback_contacts add column if not exists review_note text;
alter table public.winback_contacts add column if not exists review_quote text;
alter table public.winback_contacts add column if not exists reviewed_at timestamptz;

-- Win-back text sequence (owner, 2026-10-10; confirmed 2026-10-19): small daily
-- batches, newest leavers first, a human answers replies. Per person:
-- day-0 text → day-3 nudge → day-7 email → day-14 close-out, then the silent
-- ones get the win-back-no-reply tag. Sent by the winback-send cron.
alter table public.winback_contacts add column if not exists batch_no int;                 -- 1, 2, 3… the daily batch this person started in
alter table public.winback_contacts add column if not exists batch_started_at timestamptz;
alter table public.winback_contacts add column if not exists step int not null default 0; -- 0 not started · 1 day-0 text sent · 2 day-3 nudge · 3 day-7 email · 4 day-14 close-out
alter table public.winback_contacts add column if not exists next_due_at timestamptz;      -- when the cron may send the next step (null = nothing pending)
alter table public.winback_contacts add column if not exists last_sent_at timestamptz;
alter table public.winback_contacts add column if not exists replied_at timestamptz;       -- her reply after we started (the first one the cron saw)
alter table public.winback_contacts add column if not exists stopped_reason text check (stopped_reason in ('replied', 'opted_out', 'failed', 'finished', 'current_client', 'human'));
alter table public.winback_contacts add column if not exists send_error text;              -- last GHL send error, or why a current client was stopped
create index if not exists winback_contacts_due_idx on public.winback_contacts (next_due_at) where batch_started_at is not null and stopped_reason is null;
-- 'human' (2026-10-19): a teammate wrote to her by hand after the batch started,
-- so the sequence stepped aside. Re-stated here so a table that got the column
-- before this value existed accepts it too (the inline check above is skipped
-- once the column exists).
alter table public.winback_contacts drop constraint if exists winback_contacts_stopped_reason_check;
alter table public.winback_contacts add constraint winback_contacts_stopped_reason_check check (stopped_reason in ('replied', 'opted_out', 'failed', 'finished', 'current_client', 'human'));
