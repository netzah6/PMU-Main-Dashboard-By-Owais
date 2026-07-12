-- Per-account GHL sync health, applied to Supabase via migration
-- ghl_sync_status. ingestAccount() writes one row per account per run so a
-- stalled sub-account (broken token, marketplace app removed from the location,
-- account dropped from the roster) is visible in the dashboard instead of
-- silently producing no new leads.
--
-- last_success_at only advances on an error-free run, so it's the reliable
-- "last healthy poll" — it stays put while an account is failing, and a
-- quiet-but-healthy account (no new leads) still counts as healthy (unlike
-- contact timestamps, which only move when a lead is upserted).
CREATE TABLE IF NOT EXISTS ghl_sync_status (
  owner_key       TEXT PRIMARY KEY,
  location_id     TEXT,
  last_attempt_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  contacts        INTEGER,
  conversations   INTEGER,
  opportunities   INTEGER,
  ok              BOOLEAN,
  error           TEXT,
  updated_at      TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE ghl_sync_status ENABLE ROW LEVEL SECURITY;
-- Reads allowed for signed-in users; the /api/ghl/sync-health route additionally
-- gates to admins. Writes go through the service client (bypasses RLS).
CREATE POLICY "sync status read" ON ghl_sync_status FOR SELECT TO authenticated USING (true);
