-- CEO Agent phase 2 (2026-09-28) — APPLIED to the live project already.
--
-- action_plan  : typed steps the executor runs on Approve (see src/lib/agent-exec.ts)
-- location_id  : the client's own sub-account, resolved at scan time
-- notified_at  : when the owner was texted about this card
--
-- Owner notification settings live in app_settings under key 'agent_notify'
-- ({enabled, phone, contactId}); the last scan's log under 'agent_scan_last'.

alter table public.agent_proposals
  add column if not exists action_plan jsonb,
  add column if not exists location_id text,
  add column if not exists notified_at timestamptz;

-- 'handled' = the team answered in the chat; the scan closes the card itself
-- (APPLIED 2026-09-28).
alter table public.agent_proposals drop constraint if exists agent_proposals_status_check;
alter table public.agent_proposals add constraint agent_proposals_status_check
  check (status = any (array['pending','denied','done','failed','queued_browser','handled']));
