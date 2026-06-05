-- Add a stable `sheet_row` integer column + unique index to every data table.
-- This lets us UPSERT by sheet row number instead of truncating + re-inserting,
-- so UUIDs stay stable and Supabase Realtime only fires for rows that changed.
-- Run this ONCE in the Supabase SQL Editor.

DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'clients_master', 'leads_master', 'deposits', 'outgoing_calls',
    'bookings', 'signed_agreements', 'ltv_sheet1', 'ltv_sheet2',
    'performance_tracking', 'cpl_7days', 'cpl_14days', 'campaign_spent'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    -- add column
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS sheet_row INTEGER', t);
    -- backfill from existing jsonb row_number
    EXECUTE format($f$
      UPDATE %I SET sheet_row = NULLIF(data->>'row_number','')::int
      WHERE sheet_row IS NULL AND data ? 'row_number'
    $f$, t);
    -- de-duplicate any rows that share a sheet_row (keep the newest id)
    EXECUTE format($f$
      DELETE FROM %I a USING %I b
      WHERE a.sheet_row = b.sheet_row AND a.id < b.id
    $f$, t, t);
    -- unique index so onConflict works
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I(sheet_row)', t || '_sheet_row_uidx', t);
  END LOOP;
END $$;
