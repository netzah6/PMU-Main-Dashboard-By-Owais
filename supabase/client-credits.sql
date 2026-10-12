-- Account credit for a PPS client, e.g. to make good on a bad lead or a
-- service problem. A Client Success Coach requests it, an admin approves it —
-- same two-step shape as deposit_refunds, because it moves real money.
-- An approved credit reduces the next service-fee charge until it is used up
-- (see src/lib/credits.ts and executeChargeForRow in src/lib/ppa-verify.ts).
CREATE TABLE IF NOT EXISTS client_credits (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_key TEXT NOT NULL,
  client_label TEXT,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied')),
  -- How much of an approved credit has been used against charges so far.
  applied NUMERIC NOT NULL DEFAULT 0 CHECK (applied >= 0),
  requested_by TEXT,
  requested_at TIMESTAMPTZ DEFAULT now(),
  decided_by TEXT,
  decided_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_credits_owner_idx ON client_credits (owner_key);
CREATE INDEX IF NOT EXISTS client_credits_status_idx ON client_credits (status);

ALTER TABLE client_credits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Credits read" ON client_credits;
CREATE POLICY "Credits read" ON client_credits FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Credits request" ON client_credits;
CREATE POLICY "Credits request" ON client_credits FOR INSERT TO authenticated
  WITH CHECK (get_user_role() IN ('editor', 'admin'));
DROP POLICY IF EXISTS "Credits decide" ON client_credits;
CREATE POLICY "Credits decide" ON client_credits FOR UPDATE TO authenticated
  USING (get_user_role() = 'admin') WITH CHECK (get_user_role() = 'admin');

-- 2026-10-12: a credit can point at the show it came from. Voiding an
-- already-charged show (Cancelled / No-show / …) auto-creates an approved
-- credit for that show's fee; the link keeps it idempotent and lets a
-- Restore withdraw the unused credit. Applied to the US project via MCP.
ALTER TABLE client_credits ADD COLUMN IF NOT EXISTS appt_id text;
CREATE UNIQUE INDEX IF NOT EXISTS client_credits_appt_uq ON client_credits (appt_id) WHERE appt_id IS NOT NULL;
