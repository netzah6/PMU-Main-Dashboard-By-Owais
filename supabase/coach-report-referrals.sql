-- Referrals on the monthly Coach Report (owner request 2026-09-22).
-- A referral = a NEW PMU artist referred in by one of the clients the coach
-- already manages; each one pays the coach a $100 bonus, so the numbers ride
-- along with the report that decides pay.
alter table coach_reports
  add column if not exists referrals jsonb not null default '[]'::jsonb;

comment on column coach_reports.referrals is
  'Referrals claimed for the month: [{referred_name, referred_by, note}] — $100 bonus each, reviewed by the admin on the Alerts card.';
