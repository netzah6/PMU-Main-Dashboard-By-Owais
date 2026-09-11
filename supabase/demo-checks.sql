-- Every demo-status check run from the Team tab: the exact names pasted and
-- the verdicts returned, so any earlier list can be brought back or re-run.
CREATE TABLE IF NOT EXISTS demo_checks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_email TEXT,
  names TEXT[] NOT NULL,
  results JSONB NOT NULL,
  showed INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS demo_checks_at_idx ON demo_checks (created_at DESC);
ALTER TABLE demo_checks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Demo checks read" ON demo_checks;
CREATE POLICY "Demo checks read" ON demo_checks FOR SELECT TO authenticated USING (get_user_role() = 'admin');
