-- Recurring billing run from the dashboard instead of Square Subscriptions.
-- Square emails the client whenever a subscription is paused or resumed, which
-- confuses artists whose campaign is still running; a plain card payment sends
-- nothing (createCardPayment omits buyer_email_address). Existing Square
-- subscriptions are left alone — this covers clients who do not have one.
--
-- SAFETY: a row is created in 'draft' and charges nothing until an admin
-- activates it, and NOTHING charges at all until the global autocharge switch
-- in app_settings is turned on. Both default to off.
CREATE TABLE IF NOT EXISTS client_subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_key TEXT NOT NULL,
  client_label TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  cadence TEXT NOT NULL DEFAULT 'monthly' CHECK (cadence IN ('monthly', 'once')),
  charge_day INTEGER CHECK (charge_day BETWEEN 1 AND 28),
  next_charge_on DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','ended')),
  note TEXT,
  square_customer_id TEXT,
  square_card_id TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_by TEXT,
  activated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_subscriptions_owner_idx ON client_subscriptions (owner_key);
CREATE INDEX IF NOT EXISTS client_subscriptions_due_idx ON client_subscriptions (status, next_charge_on);

CREATE TABLE IF NOT EXISTS subscription_charges (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  subscription_id UUID NOT NULL REFERENCES client_subscriptions(id) ON DELETE CASCADE,
  owner_key TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded','failed')),
  square_payment_id TEXT,
  receipt_url TEXT,
  error TEXT,
  charged_by TEXT,
  period_key TEXT,
  charged_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscription_charges_sub_idx ON subscription_charges (subscription_id, charged_at DESC);
-- At most one success per billing period, whatever retries or double-clicks happen.
CREATE UNIQUE INDEX IF NOT EXISTS subscription_charges_period_uniq
  ON subscription_charges (subscription_id, period_key) WHERE status = 'succeeded';

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO app_settings (key, value) VALUES ('subscription_autocharge', '{"enabled": false}'::jsonb)
  ON CONFLICT (key) DO NOTHING;

ALTER TABLE client_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Subscriptions read" ON client_subscriptions;
CREATE POLICY "Subscriptions read" ON client_subscriptions FOR SELECT TO authenticated USING (get_user_role() = 'admin');
DROP POLICY IF EXISTS "Subscription charges read" ON subscription_charges;
CREATE POLICY "Subscription charges read" ON subscription_charges FOR SELECT TO authenticated USING (get_user_role() = 'admin');
DROP POLICY IF EXISTS "App settings read" ON app_settings;
CREATE POLICY "App settings read" ON app_settings FOR SELECT TO authenticated USING (get_user_role() = 'admin');

-- Every pause / resume / cancel-pause issued to Square from the dashboard, with
-- what Square answered, so the activity feed shows who did what and when.
CREATE TABLE IF NOT EXISTS square_subscription_actions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  customer_name TEXT,
  action TEXT NOT NULL CHECK (action IN ('pause', 'resume', 'cancel_pause')),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  detail TEXT,
  error TEXT,
  actor TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS square_subscription_actions_at_idx ON square_subscription_actions (created_at DESC);
ALTER TABLE square_subscription_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Square actions read" ON square_subscription_actions;
CREATE POLICY "Square actions read" ON square_subscription_actions FOR SELECT TO authenticated USING (get_user_role() = 'admin');
