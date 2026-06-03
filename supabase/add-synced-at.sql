-- Add synced_at column to all data tables (if it doesn't exist)
-- Run this in Supabase SQL Editor

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
    BEGIN
      EXECUTE format(
        'ALTER TABLE %I ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ DEFAULT NOW()',
        t
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Could not alter %: %', t, SQLERRM;
    END;
  END LOOP;
END $$;
