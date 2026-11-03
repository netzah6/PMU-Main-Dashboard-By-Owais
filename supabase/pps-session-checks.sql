-- PPS session check (owner, 11/03/2026): every Sunday the AI reads the chat of
-- each appointment that could be billed without proof — past-due deposit
-- appointments, past calendar bookings with no deposit, "Deposit Collected"
-- leads with no deposit on record, and chat-detected bookings — and decides
-- whether the session really happened. One row per thing checked; the
-- billing decision itself is written to ppa_charges (the table the billing
-- tab and the Monday auto-charge already read).
create table if not exists pps_session_checks (
  check_key       text primary key,          -- d_… (deposit) · cal:… · dc:<opp id> · chat:<conversation id>
  owner_key       text not null,
  kind            text not null,             -- deposit | calendar | deposit_stage | chat
  contact_id      text,
  contact_name    text,
  appt_time       timestamptz,
  verdict         text not null,             -- done | no_show | cancelled | not_yet | unsure
  session_date    date,
  reason          text,
  evidence        text,
  action          text,                      -- billed | voided | held | none
  billed_appt_id  text,                      -- the ppa_charges row this check wrote, if any
  checked_at      timestamptz not null default now(),
  model           text
);
create index if not exists pps_session_checks_owner on pps_session_checks (owner_key, checked_at desc);
alter table pps_session_checks enable row level security;
