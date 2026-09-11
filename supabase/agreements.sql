-- Every agreement generated from the Agreement tab, so an edited version can be
-- reopened and re-downloaded later. The standard template itself lives in
-- app_settings under 'agreement_template' (seeded from code on first use).
CREATE TABLE IF NOT EXISTS agreements (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  partner_name TEXT,
  content JSONB NOT NULL,
  changes TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agreements_at_idx ON agreements (created_at DESC);
ALTER TABLE agreements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Agreements read" ON agreements;
CREATE POLICY "Agreements read" ON agreements FOR SELECT TO authenticated USING (get_user_role() = 'admin');
