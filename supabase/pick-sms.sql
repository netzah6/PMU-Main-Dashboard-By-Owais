-- 11/21/2026 (owner): "you picked a time" text for QUIET pickers — one-box
-- leads who picked a time but never texted back (the AI only talks after the
-- lead texts, so they get no pay link by text). 50/50 (text vs no text), one
-- text per contact ever, switched on only after the owner approves the text
-- (app_settings "pick_sms", default off). Both sides are recorded: a row is
-- enrolled "pending" at the pick, then every check runs for both sides at the
-- same moment (about 1 h later, daytime for the lead) — text side → "sent",
-- hold side → "held". See src/lib/pick-sms.ts.
create table if not exists public.pick_sms_people (
  contact_id   text primary key,
  location_id  text not null,
  slug         text not null,
  lead_id      bigint,                            -- her newest onebox_leads row at enrolment
  phone        text,                              -- kept for the same-phone paid check
  arm          text not null check (arm in ('sms', 'hold')),
  picked_at    timestamptz not null,
  slot_at      timestamptz,                       -- the picked time (the one the text names, once decided)
  status       text not null default 'pending',   -- pending | sent | held | paid | paid_earlier | replied | sms_dnd | no_phone | slot_passed | booked | contact_gone | funnel_off | too_late | no_lead_row | not_v3 | ai_off | send_failed | check_failed | paused
  due_at       timestamptz,                       -- next check (pending only)
  attempts     int not null default 0,
  decided_at   timestamptz,                       -- passed every check: the moment the text went (or, hold side, would have)
  sent_at      timestamptz,
  message_id   text,                              -- GHL message id of the text
  ai_restore   text,                              -- after the text: AI back on? ok | ok_no_shutoff_seen | failed (CloseBot switches itself off on our text)
  ai_restore_at timestamptz,
  clicked_at   timestamptz,                       -- first open of the ?via=sms link
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists pick_sms_people_due on public.pick_sms_people (due_at) where status = 'pending';
alter table public.pick_sms_people enable row level security;
-- No policies: only the service role (admin-gated API routes, the cron) reads or writes.

-- The switch, OFF (the code also treats a missing row as off).
insert into public.app_settings (key, value, updated_at)
values ('pick_sms', '{"enabled": false, "startAt": null}'::jsonb, now())
on conflict (key) do nothing;
