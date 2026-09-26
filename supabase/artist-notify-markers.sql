-- Artist booking-notification markers (2026-09-26): the artist-notify
-- cron checks each freshly booked one-box lead's artist thread and sends
-- the "appointment secured" text only when the account's own workflow
-- did not fire (the Fanbasis-tag race). These columns make the cron
-- idempotent and auditable.
-- Applied to production (rtmiakhhohhfaqghieri) 2026-09-26.
alter table public.onebox_leads
  add column if not exists artist_notified_at timestamptz,
  add column if not exists artist_notify_note text;
