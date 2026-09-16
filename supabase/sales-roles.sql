-- Sales seats on the dashboard (2026-09-16): "setter" (discovery side of the
-- Sales tab), "closer" (their own demos) and "sales" (both). sales_name is
-- the name the person goes by in the Sales Calls Stats sheet — the closer
-- side is filtered to it. Already applied to production.
alter table public.user_roles drop constraint if exists user_roles_role_check;
alter table public.user_roles add constraint user_roles_role_check
  check (role = any (array['admin','editor','viewer','va','media_buyer','setter','closer','sales']));
alter table public.user_roles add column if not exists sales_name text;
