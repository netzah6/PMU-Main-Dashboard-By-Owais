-- Deposit refund requests with an in-dashboard approval queue.
-- Applied to Supabase via migration deposit_refunds. Team members (editor/admin)
-- request a refund; only an admin (Nicolas) can approve, which executes the
-- refund on Fanbasis. Money never moves without an explicit admin approval.
CREATE TABLE IF NOT EXISTS deposit_refunds (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  deposit_key    TEXT NOT NULL,
  business       TEXT,
  contact_name   TEXT,
  email          TEXT,
  amount         TEXT,
  product_id     TEXT,
  deposit_date   TEXT,
  reason         TEXT,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','denied','refunded','failed')),
  requested_by   TEXT,
  requested_at   TIMESTAMPTZ DEFAULT now(),
  decided_by     TEXT,
  decided_at     TIMESTAMPTZ,
  fanbasis_transaction_id TEXT,
  fanbasis_result JSONB,
  error          TEXT,
  updated_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deposit_refunds_key_idx ON deposit_refunds (deposit_key);
CREATE INDEX IF NOT EXISTS deposit_refunds_status_idx ON deposit_refunds (status);

ALTER TABLE deposit_refunds ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Refunds read" ON deposit_refunds FOR SELECT TO authenticated USING (true);
CREATE POLICY "Refunds request" ON deposit_refunds FOR INSERT TO authenticated
  WITH CHECK (get_user_role() IN ('editor','admin'));
CREATE POLICY "Refunds decide" ON deposit_refunds FOR UPDATE TO authenticated
  USING (get_user_role() = 'admin') WITH CHECK (get_user_role() = 'admin');