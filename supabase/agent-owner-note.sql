-- CEO Agent: "Correct & retry" (owner request 2026-10-15) — APPLIED to the
-- live project already.
--
-- When the AI misread a request or could not find the client's sub-account
-- ("no Clients Master match"), the owner types a note on the card (who the
-- client is, what to do instead) and the chat is re-planned WITH that note.
-- owner_note : the owner's correction, shown on the new card and given to
--              the planner and the Mac Mini as authoritative context
-- retry_of   : the card this one replaces
alter table public.agent_proposals
  add column if not exists owner_note text,
  add column if not exists retry_of uuid;
