-- 🔁 Win-back tracker fields (applied on prod 11/06/2026).
alter table winback_contacts
  add column if not exists planned_send_at timestamptz,
  add column if not exists followup_sent_at timestamptz,
  add column if not exists followup_kind text,
  add column if not exists followup_until text;
