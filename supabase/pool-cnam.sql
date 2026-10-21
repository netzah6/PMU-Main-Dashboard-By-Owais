-- Clean-account pool: CNAM (caller name) reset by the AI Agent (2026-10-21).
-- A recycled sub-account keeps the previous clients' approved CNAMs in the
-- Trust Center, which disables "Start Registration" for the new client
-- (Sudbury Med Spa on Clean New Account 79). GHL's UI cannot delete a CNAM;
-- only GHL support can. On every wipe the AI Agent reads the CNAMs and, when
-- they are not "PermanentMakeup", asks GHL support (chat) to remove them;
-- the weekly sweep checks back until they are gone. Additive only.
alter table public.pool_accounts
  add column if not exists cnam_status text,          -- 'ok' | 'requested' | 'stale' | null (never checked)
  add column if not exists cnam_note text,
  add column if not exists cnam_task_id text,
  add column if not exists cnam_queued_at timestamptz,
  add column if not exists cnam_updated_at timestamptz;
comment on column public.pool_accounts.cnam_status is
  'ok = no foreign CNAM on the Trust Center; requested = GHL support asked to remove the old names; stale = old names there and no request could be made.';
