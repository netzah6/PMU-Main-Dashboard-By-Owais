-- 🔁 Win-back tracker fields (applied on prod 11/06/2026).
alter table winback_contacts
  add column if not exists planned_send_at timestamptz,
  add column if not exists followup_sent_at timestamptz,
  add column if not exists followup_kind text,
  add column if not exists followup_until text;

-- Picks for the next blast (applied on prod 11/06/2026).
alter table winback_contacts add column if not exists picked_at timestamptz;
create table if not exists winback_demo_picks (
  name_key text primary key,
  name text not null,
  demo_status text,
  demo_date date,
  closer text,
  picked_at timestamptz not null default now(),
  picked_by text
);
alter table winback_demo_picks enable row level security;
