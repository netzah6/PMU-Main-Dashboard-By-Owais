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
