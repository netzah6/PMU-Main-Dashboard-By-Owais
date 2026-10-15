-- New client setup run (2026-10-15). The Onboarding card records the owner's
-- approval, the clean account it took, and the live state of every runbook
-- step (API steps the dashboard ran, browser steps the Mac Mini did, pauses
-- waiting for the owner). One JSON column — the card already keeps `form`,
-- `checklist` and `claim` the same way.
--
-- Mac Mini steps ride on agent_proposals rows with
--   conversation_id = 'setup:<onboarding id>:<runbook step key>'
-- (no new column: the worker's finish hook parses that prefix).
--
-- APPLY: Supabase SQL editor (or the MCP) — ask the owner first.
alter table public.onboardings add column if not exists setup jsonb;
comment on column public.onboardings.setup is
  'New-client setup run: approval (who/when/location), per-step state, screenshots, the employee password (shown only on the card), final summary.';
