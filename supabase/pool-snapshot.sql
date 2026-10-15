-- Clean-account pool: snapshot reload (2026-10-15).
--
-- The Cleanup wipe deletes a recycled sub-account's custom values, custom
-- fields and calendars, and the GHL API cannot load a snapshot onto an
-- existing location — so every recycled account (Clean New Account 71+) sat
-- in the pool EMPTY, and the first New Client Setup on one (Sally Nails And
-- Spa, 10/15/2026) found every custom value "missing".
--
-- From now on finalize queues ONE Mac Mini task that loads the newest
-- "Demo (V2/V3) Snapshop …" snapshot from the agency Sub-Accounts screen,
-- and an account counts as READY only once that task finished (or a
-- Re-check sees the template in it). Rows ride on agent_proposals with
--   conversation_id = 'pool:<location id>:snapshot_load'
--
-- APPLY: Supabase SQL editor (or the MCP) BEFORE merging the PR — ask the
-- owner first. Nullable columns only; nothing is rewritten.
alter table public.pool_accounts
  add column if not exists snapshot_task_id text,
  add column if not exists snapshot_queued_at timestamptz,
  add column if not exists snapshot_loaded_at timestamptz,
  add column if not exists snapshot_note text;
comment on column public.pool_accounts.snapshot_loaded_at is
  'When the Demo snapshot was last confirmed on this pool account (Mac Mini task done, or Re-check found CC custom values + the template workflows). NULL = waiting for snapshot, never offered for a setup.';
comment on column public.pool_accounts.snapshot_task_id is
  'agent_proposals id of the latest snapshot-load task queued for the Mac Mini.';

alter table public.cleanup_log
  add column if not exists snapshot_task_id text,
  add column if not exists snapshot_loaded_at timestamptz;
