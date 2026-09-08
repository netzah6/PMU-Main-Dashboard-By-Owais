-- Which charge each dollar of account credit came off. client_credits.applied
-- says HOW MUCH of a credit is spent but not against what, so a client asking
-- "why was I charged $100 and not $135?" could not be answered from the data.
-- One row per (credit, charge) pair — a payment may draw down several credits,
-- and one credit may be spread across several payments.
CREATE TABLE IF NOT EXISTS credit_applications (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  credit_id UUID NOT NULL REFERENCES client_credits(id) ON DELETE CASCADE,
  owner_key TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  -- NULL when the credit covered the whole bill and no card was charged.
  square_payment_id TEXT,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credit_applications_owner_idx ON credit_applications (owner_key, applied_at DESC);
CREATE INDEX IF NOT EXISTS credit_applications_payment_idx ON credit_applications (square_payment_id);

ALTER TABLE credit_applications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Credit applications read" ON credit_applications;
CREATE POLICY "Credit applications read" ON credit_applications FOR SELECT TO authenticated USING (true);
