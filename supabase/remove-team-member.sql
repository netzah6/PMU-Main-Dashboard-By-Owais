-- Remove team member (Settings → Remove button).
--
-- Revoking someone's dashboard access has three parts, all done by
-- /api/users/remove: delete their user_roles row, ban the auth user, and kill
-- their live sessions. The first two go through the Supabase admin API; there
-- is no admin endpoint that signs out another user's sessions, so this RPC
-- does it in SQL. Without it a removed member could keep an open tab alive
-- for up to an hour — and a missing user_roles row defaults to "viewer".
--
-- We deliberately do NOT delete the auth.users row: client_activity.created_by
-- references it, so deleting would erase who wrote each note.
--
-- Callable by service_role only (same lockdown as rpc-lockdown.sql).

create or replace function public.revoke_user_sessions(uid uuid)
returns integer
language sql
security definer
set search_path = ''
as $$
  with t as (
    delete from auth.refresh_tokens where user_id = uid::text returning 1
  ), s as (
    delete from auth.sessions where user_id = uid returning 1
  )
  select (select count(*) from s)::integer;
$$;

revoke all on function public.revoke_user_sessions(uuid) from public, anon, authenticated;
grant execute on function public.revoke_user_sessions(uuid) to service_role;
