-- PMU Dashboard Supabase Schema
-- Run this in Supabase SQL Editor to set up all tables

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Helper function to create standard jsonb data tables
CREATE OR REPLACE FUNCTION create_data_table(table_name TEXT) RETURNS void AS $$
BEGIN
  EXECUTE format('
    CREATE TABLE IF NOT EXISTS %I (
      id BIGSERIAL PRIMARY KEY,
      data JSONB NOT NULL DEFAULT ''{}''::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_%I_data ON %I USING gin(data);
  ', table_name, table_name, table_name);
END;
$$ LANGUAGE plpgsql;

-- Create all data tables
SELECT create_data_table('clients_master');
SELECT create_data_table('leads_master');
SELECT create_data_table('deposits');
SELECT create_data_table('outgoing_calls');
SELECT create_data_table('bookings');
SELECT create_data_table('signed_agreements');
SELECT create_data_table('ltv_sheet1');
SELECT create_data_table('ltv_sheet2');
SELECT create_data_table('performance_tracking');
SELECT create_data_table('cpl_7days');
SELECT create_data_table('cpl_14days');
SELECT create_data_table('campaign_spent');

-- User roles table
CREATE TABLE IF NOT EXISTS user_roles (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')) DEFAULT 'viewer',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

-- Client notes table (optional extra notes)
CREATE TABLE IF NOT EXISTS client_notes (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  client_id TEXT NOT NULL,
  note TEXT NOT NULL,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ===== ROW LEVEL SECURITY =====

-- Enable RLS on all tables
ALTER TABLE clients_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE outgoing_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE signed_agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE ltv_sheet1 ENABLE ROW LEVEL SECURITY;
ALTER TABLE ltv_sheet2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE cpl_7days ENABLE ROW LEVEL SECURITY;
ALTER TABLE cpl_14days ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_spent ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_notes ENABLE ROW LEVEL SECURITY;

-- Helper: check if current user has a role
CREATE OR REPLACE FUNCTION get_user_role() RETURNS TEXT AS $$
  SELECT role FROM user_roles WHERE user_id = auth.uid() LIMIT 1;
$$ LANGUAGE SQL SECURITY DEFINER;

-- Policies: authenticated users can read all data tables
CREATE POLICY "Authenticated read" ON clients_master FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read" ON leads_master FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read" ON deposits FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read" ON outgoing_calls FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read" ON bookings FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read" ON signed_agreements FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read" ON ltv_sheet1 FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read" ON ltv_sheet2 FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read" ON performance_tracking FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read" ON cpl_7days FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read" ON cpl_14days FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read" ON campaign_spent FOR SELECT TO authenticated USING (true);

-- Editors and admins can write to data tables
CREATE POLICY "Editor/Admin write clients" ON clients_master
  FOR ALL TO authenticated
  USING (get_user_role() IN ('editor', 'admin'))
  WITH CHECK (get_user_role() IN ('editor', 'admin'));

CREATE POLICY "Editor/Admin write deposits" ON deposits
  FOR ALL TO authenticated
  USING (get_user_role() IN ('editor', 'admin'))
  WITH CHECK (get_user_role() IN ('editor', 'admin'));

-- user_roles: users can read their own role, admins can read all
CREATE POLICY "Read own role" ON user_roles FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Admin read all roles" ON user_roles FOR SELECT TO authenticated USING (get_user_role() = 'admin');
CREATE POLICY "Admin write roles" ON user_roles FOR ALL TO authenticated
  USING (get_user_role() = 'admin')
  WITH CHECK (get_user_role() = 'admin');

-- Service role bypass (for cron and webhook routes)
-- The SUPABASE_SERVICE_ROLE_KEY bypasses RLS automatically

-- ===== REALTIME =====
-- Enable realtime on clients_master
ALTER PUBLICATION supabase_realtime ADD TABLE clients_master;

-- ===== INITIAL ADMIN USER =====
-- Run this AFTER the first admin user signs up via the UI
-- Replace USER_ID with the actual UUID from auth.users
/*
INSERT INTO user_roles (user_id, email, role)
VALUES
  ('USER_ID_HERE', 'Nicolad@pmu-bookings.com', 'admin'),
  ('USER_ID_HERE', 'Stephanie@pmu-bookings.com', 'editor')
ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role;
*/
