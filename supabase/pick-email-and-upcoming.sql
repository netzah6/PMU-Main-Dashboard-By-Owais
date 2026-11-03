-- 11/03/2026 (owner): "finish your deposit" email to leads who picked a time
-- on the booking page but didn't pay — 50/50 (email vs no email), switched on
-- only after the owner approves the two emails (planned 11/25). One row per
-- GHL contact; the hold side is recorded too so the two sides can be compared.
create table if not exists public.pick_email_people (
  contact_id    text primary key,
  location_id   text not null,
  slug          text not null,
  arm           text not null check (arm in ('email', 'hold')),
  picked_at     timestamptz not null,
  slot_iso      text,
  step          int not null default 0,          -- emails sent so far (0–2)
  next_due_at   timestamptz,
  sent1_at      timestamptz,
  sent2_at      timestamptz,
  attempts      int not null default 0,
  stopped_reason text,                            -- paid | slot_passed | no_email | email_dnd | contact_gone | failed | finished | hold
  send_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists pick_email_people_due on public.pick_email_people (next_due_at) where stopped_reason is null;
alter table public.pick_email_people enable row level security;
-- No policies: only the service role (admin-gated API routes, the cron) reads or writes.

-- 11/03/2026 (owner): "where can I track all the future builds — what you're
-- going to do on which date?" → the 🗓️ Upcoming tab. Claude keeps these rows
-- current; the owner can tick an item done.
create table if not exists public.planned_items (
  id          bigserial primary key,
  due_date    date,                               -- null = no date yet
  due_label   text,                               -- shown instead of the date, e.g. "~11/09" or "11/18–11/25"
  title       text not null,
  detail      text,
  who         text not null default 'claude' check (who in ('auto', 'claude', 'claude_ok', 'owner', 'outside')),
  status      text not null default 'planned' check (status in ('scheduled', 'planned', 'waiting', 'parked', 'done')),
  area        text,
  sort        int not null default 0,
  done_at     timestamptz,
  done_by     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.planned_items enable row level security;
-- No policies: only the service role (admin-gated API routes) reads or writes.

-- 11/03/2026 review fix: the phone is kept on the row so the same-phone paid
-- check never depends on the lead row still being linked to the contact.
alter table public.pick_email_people add column if not exists phone text;
