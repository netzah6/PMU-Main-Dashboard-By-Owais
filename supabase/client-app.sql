-- Client phone app (owner, 11/11/2026).
-- Per-client switches: a feature is SHOWN locked until the team turns it on.
CREATE TABLE IF NOT EXISTS public.client_app_settings (
  owner_key            text PRIMARY KEY,
  reviews_on           boolean NOT NULL DEFAULT false,   -- Google Reviews section unlocked
  reviews_requested_at timestamptz,                      -- the client tapped "ask my team to turn this on"
  reviews_on_by        text,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.client_app_settings ENABLE ROW LEVEL SECURITY; -- service role only

-- Google review count over time (one point per day per funnel), so the app
-- can say how many reviews a client gained.
CREATE TABLE IF NOT EXISTS public.client_review_history (
  slug         text NOT NULL,
  day          date NOT NULL,
  rating       numeric,
  review_count integer NOT NULL,
  PRIMARY KEY (slug, day)
);
ALTER TABLE public.client_review_history ENABLE ROW LEVEL SECURITY; -- service role only

-- Client app · Profit (owner, 11/12/2026): her own prices, her own amount for
-- a client, and her expenses. Her notes only — nothing here feeds billing.
CREATE TABLE IF NOT EXISTS public.client_app_profit_settings (
  owner_key text PRIMARY KEY,
  session_price numeric(10,2),
  touchup_price numeric(10,2),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.client_app_profit_settings ENABLE ROW LEVEL SECURITY; -- service role only

CREATE TABLE IF NOT EXISTS public.client_app_profit_amounts (
  owner_key text NOT NULL,
  client_ref text NOT NULL,
  amount numeric(10,2) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_key, client_ref)
);
ALTER TABLE public.client_app_profit_amounts ENABLE ROW LEVEL SECURITY; -- service role only

CREATE TABLE IF NOT EXISTS public.client_app_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_key text NOT NULL,
  label text NOT NULL,
  amount numeric(10,2) NOT NULL,
  kind text NOT NULL CHECK (kind IN ('monthly', 'once')),
  month text NOT NULL,      -- 'YYYY-MM': the month of a one-time expense, or the first month of a monthly one
  end_month text,           -- a stopped monthly expense no longer counts from this month on
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_app_expenses_owner ON public.client_app_expenses (owner_key, created_at);
ALTER TABLE public.client_app_expenses ENABLE ROW LEVEL SECURITY; -- service role only

-- Profit set-up steps (owner, 11/12/2026): clients first, then costs, then the
-- profit. And a cost can be per client (rent paid per appointment).
ALTER TABLE public.client_app_profit_settings ADD COLUMN IF NOT EXISTS clients_done_at timestamptz;
ALTER TABLE public.client_app_profit_settings ADD COLUMN IF NOT EXISTS setup_done_at timestamptz;
ALTER TABLE public.client_app_expenses DROP CONSTRAINT IF EXISTS client_app_expenses_kind_check;
ALTER TABLE public.client_app_expenses ADD CONSTRAINT client_app_expenses_kind_check CHECK (kind IN ('monthly', 'per_client', 'once'));

-- Two values per client (owner, 11/12/2026): first treatment (amount) + touch-up; one of the two is enough.
ALTER TABLE public.client_app_profit_amounts ADD COLUMN IF NOT EXISTS touchup_amount numeric(10,2);
ALTER TABLE public.client_app_profit_amounts ALTER COLUMN amount DROP NOT NULL;

-- Daily ad budget she picked in the app (owner, 11/12/2026): $25/day to start.
ALTER TABLE public.client_app_settings ADD COLUMN IF NOT EXISTS ad_budget_daily integer;
ALTER TABLE public.client_app_settings ADD COLUMN IF NOT EXISTS ad_budget_at timestamptz;
