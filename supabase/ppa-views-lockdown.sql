-- Billing views hold lead names and emails, and were readable with the public
-- key. Every reader in the app uses the service client, so only it keeps access.
-- create or replace view keeps these grants; a drop + create brings them back.
revoke all on public.ppa_selfbooked, public.ppa_calendar_booked from anon, authenticated;
