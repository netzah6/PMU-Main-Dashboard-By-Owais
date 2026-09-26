-- Optional hardening for the "charge any amount" path (2026-09-26). NOT APPLIED.
--
-- When a part payment collects more than the whole shows it settles, the
-- leftover is banked as an approved client_credits row keyed on a reason
-- string containing the Square payment id, and executeChargeForRow guards the
-- insert with a select-then-insert. That guard is not atomic and the table has
-- no unique constraint (see client-credits.sql — only non-unique indexes on
-- owner_key and status), so two charge-runs racing on the same client can both
-- read "no row" and both insert, banking the leftover twice.
--
-- Square's idempotency means both attempts share one payment id, so the reason
-- strings are identical and this index turns the second insert into a plain
-- error the code already reports instead of a duplicated credit.
--
-- Safe and additive. Run it only if the duplicate check below returns nothing.
--
--   select owner_key, reason, count(*)
--   from client_credits group by 1, 2 having count(*) > 1;

create unique index concurrently if not exists client_credits_owner_reason_uniq
  on public.client_credits (owner_key, reason);
