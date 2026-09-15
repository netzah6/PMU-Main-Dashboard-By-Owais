-- Sales tab mirrors of the "Sales Calls Stats" sheet + the setter/closer tracker
-- follow-up sheets (SHEET_MAP in src/lib/sheets.ts, synced every 15 min by the
-- sheet-sync cron). Already applied to production on 2026-09-15; kept here so a
-- fresh project can recreate them. Same shape as the other sheet mirrors.
do $$
declare t text;
begin
  foreach t in array array[
    'sales_discoveries', 'sales_demos', 'sales_fu_disc_noshow', 'sales_fu_disc_cancelled',
    'sales_fu_didnt_book', 'sales_fu_demo_noshow', 'sales_fu_demo_didnt_close'
  ] loop
    execute format('create table if not exists public.%I (
      id bigint generated always as identity primary key,
      data jsonb not null default ''{}''::jsonb,
      sheet_row integer not null unique,
      synced_at timestamptz not null default now()
    )', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "Authenticated read" on public.%I', t);
    execute format('create policy "Authenticated read" on public.%I for select to authenticated using (true)', t);
  end loop;
end $$;
