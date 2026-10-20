-- Clean-account pool: A2P verification by the AI Agent (2026-10-20).
-- GHL's API has no A2P status, so the pool's a2p flag was hand-set and never
-- re-verified. The AI Agent now reads each account's Trust Center page
-- (weekly cron + "Verify A2P" button); these columns track the open task
-- and what it saw. Applied on prod 10/20/2026 via the MCP. Additive only.
alter table public.pool_accounts
  add column if not exists a2p_task_id text,
  add column if not exists a2p_queued_at timestamptz,
  add column if not exists a2p_note text;
comment on column public.pool_accounts.a2p_note is
  'What the AI Agent saw on the Trust Center page, with the date. a2p_updated_by = ''AI Agent'' when the flag came from that check.';
