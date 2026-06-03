-- Fix RLS: drop any conflicting policies and recreate cleanly
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
    -- Enable RLS
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- Drop any existing read policy (ignore error if it doesn''t exist)
    BEGIN
      EXECUTE format('DROP POLICY IF EXISTS "Authenticated read" ON %I', t);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    -- Create permissive read policy for all authenticated users
    EXECUTE format(
      'CREATE POLICY "Authenticated read" ON %I FOR SELECT TO authenticated USING (true)',
      t
    );
    -- Allow service role to write (for cron/webhook)
    BEGIN
      EXECUTE format('DROP POLICY IF EXISTS "Service write" ON %I', t);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    EXECUTE format(
      'CREATE POLICY "Service write" ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)',
      t
    );
  END LOOP;
END $$;

-- Fix user_roles: set the admin user_id to the actual auth user
-- First, see who is in auth.users:
SELECT id, email, created_at FROM auth.users;

-- Then update user_roles with the correct user_id:
-- (replace 'YOUR-EMAIL-HERE' with your actual login email)
UPDATE user_roles
SET user_id = (SELECT id FROM auth.users WHERE email = 'YOUR-EMAIL-HERE' LIMIT 1)
WHERE user_id IS NULL;

-- Verify
SELECT ur.*, au.email as auth_email
FROM user_roles ur
LEFT JOIN auth.users au ON au.id = ur.user_id;
