-- Kill Rate for the CPD tab (2026-09-22): per sub-account, how often the AI
-- died after an artist's outgoing call ("CC - Outgoing Call -> Google Sheet
-- Webhook" removes the lead from the AI flow — found via Venita Lewis /
-- Tangilaya Thomas). Computed daily by /api/cron/call-kill over a 21-day
-- window; the Cost/Deposit (CPD) tab reads it as the "Kill %" column.
-- Applied to production (rtmiakhhohhfaqghieri) 2026-09-22.
create table if not exists public.call_kill_stats (
  slug text primary key,
  owner_key text not null default '',
  called int not null default 0,      -- called, non-paid, qualified one-box leads
  dead int not null default 0,        -- AI never spoke again (incl. ignored)
  ignored int not null default 0,     -- lead replied after the call, AI silent >2h
  closures int not null default 0,    -- STOP / not interested — excluded from dead
  window_start date,
  computed_at timestamptz not null default now()
);
alter table public.call_kill_stats enable row level security;
drop policy if exists call_kill_stats_read on public.call_kill_stats;
create policy call_kill_stats_read on public.call_kill_stats for select to authenticated using (true);
