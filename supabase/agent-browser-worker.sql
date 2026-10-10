-- AI agent, browser worker on the Mac Mini (owner, 2026-10-10: every task
-- done in a real browser, with screenshots as proof).
-- Approve now queues the card (queued_browser); the Mac Mini claims it
-- (running), does it in Chrome, and finishes it (done / failed /
-- needs_teammate) with screenshots.

alter table public.agent_proposals
  add column if not exists browser_claimed_at timestamptz,
  add column if not exists browser_attempts int not null default 0,
  add column if not exists screenshots jsonb;

alter table public.agent_proposals drop constraint if exists agent_proposals_status_check;
alter table public.agent_proposals add constraint agent_proposals_status_check
  check (status = any (array['pending','denied','done','failed','queued_browser','running','needs_teammate','handled']));

-- Before this, queued_browser meant "a teammate must do it by hand" — those
-- old cards must not be picked up by the worker.
update public.agent_proposals set status = 'needs_teammate' where status = 'queued_browser';

-- Proof screenshots. Public so they can ride along in the owner's text (MMS);
-- paths are random UUIDs.
insert into storage.buckets (id, name, public) values ('agent-proofs', 'agent-proofs', true)
  on conflict (id) do nothing;
