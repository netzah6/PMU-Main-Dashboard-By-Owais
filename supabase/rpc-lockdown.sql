-- ---------------------------------------------------------------------------
-- Lock down privileged RPCs so the PUBLIC anon key cannot call them.
-- Added 2026-09-22 after the Supabase rls_disabled_in_public alert; the alert
-- itself was about two tables (see client-live-seen.sql / coach-tracker-hidden.sql),
-- but auditing it turned up this larger hole.
--
-- WHY THIS MATTERS
-- ask_ai_query() is SECURITY DEFINER and runs arbitrary read-only SQL as the
-- table owner. While anon could execute it, anyone holding the public anon key
-- (it ships in the browser bundle) could read ANY table -- leads_master PII,
-- ghl_oauth tokens -- with RLS bypassed entirely. The others let anon mutate
-- coach snapshots or trigger expensive refreshes on demand.
--
-- THE TRAP: these functions were granted EXECUTE to *PUBLIC*, not just to anon.
-- Postgres shows that as an ACL entry with an empty grantee: `=X/postgres`.
-- Because anon and authenticated inherit from PUBLIC, a migration that only did
--     revoke execute ... from anon, authenticated;
-- would have LOOKED like it fixed things while changing nothing. The revoke
-- must name `public`. Verify with:
--     select proname, array_to_string(proacl, E'\n') from pg_proc ...
-- and confirm no `=X/` line remains.
--
-- DO NOT add get_user_role() or is_admin() to this list. Both are used inside
-- RLS policy expressions (24 and 2 policies respectively) which evaluate as the
-- *calling* role, so `authenticated` genuinely needs EXECUTE on them. Revoking
-- would break every admin read in the dashboard.
--
-- Safe because every caller is server-side: 24h of production edge logs show
-- 100% of calls to these RPCs arriving with the service_role key via
-- createServerClient, and take_coach_snapshot() additionally runs from pg_cron
-- as the postgres role. Both postgres and service_role keep explicit grants.
-- ---------------------------------------------------------------------------

revoke execute on function public.ask_ai_query(text)            from public, anon, authenticated;
revoke execute on function public.take_coach_snapshot()         from public, anon, authenticated;
revoke execute on function public.refresh_ppa_facts()           from public, anon, authenticated;
revoke execute on function public.refresh_booking_stats()       from public, anon, authenticated;
revoke execute on function public.max_row_number(text)          from public, anon, authenticated;
revoke execute on function public.duplicate_lead_count(integer) from public, anon, authenticated;
revoke execute on function public.ingest_health(integer)        from public, anon, authenticated;
revoke execute on function public.create_data_table(text)       from public, anon, authenticated;

-- Idempotent re-assert so the server paths keep working regardless of prior state.
grant execute on function public.ask_ai_query(text)            to service_role;
grant execute on function public.take_coach_snapshot()         to service_role;
grant execute on function public.refresh_ppa_facts()           to service_role;
grant execute on function public.refresh_booking_stats()       to service_role;
grant execute on function public.max_row_number(text)          to service_role;
grant execute on function public.duplicate_lead_count(integer) to service_role;
grant execute on function public.ingest_health(integer)        to service_role;
grant execute on function public.create_data_table(text)       to service_role;
