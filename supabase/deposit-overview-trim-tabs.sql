-- Business names pasted into the Deposits sheet can carry a trailing TAB
-- ("BeyondBrowz\t" — 6 deposits, 2026-09-01..03). Postgres TRIM() only strips
-- spaces, so those rows never matched Clients Master and showed 0 on the
-- Cost / Deposit tab. Swap every TRIM in deposit_overview for a trim that also
-- eats tabs, CR/LF and non-breaking spaces. Run once in the SQL editor.

create or replace function public.ws_trim(text) returns text
language sql immutable strict as $$ select btrim($1, E' \t\r\n ') $$;

do $$
declare def text;
begin
  def := pg_get_viewdef('public.deposit_overview'::regclass, true);
  def := replace(def, 'TRIM(BOTH FROM ', 'public.ws_trim(');
  execute 'create or replace view public.deposit_overview as ' || def;
end $$;

-- Verify: BeyondBrowz should now show d30 = 2 (two distinct payers).
-- select owner_name, ad_account_name, d30 from deposit_overview where owner_name ilike '%nyla%';
