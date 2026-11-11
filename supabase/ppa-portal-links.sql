-- Client-facing "My Billing" page (owner, 11/11/2026): one secret link per
-- PPA client, read-only. The token IS the access — no login — so it is long,
-- random and never guessable; the page shows only that client's own billing.
CREATE TABLE IF NOT EXISTS public.ppa_portal_links (
  owner_key      text PRIMARY KEY,
  token          text NOT NULL UNIQUE,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_viewed_at timestamptz,
  views          integer NOT NULL DEFAULT 0
);
ALTER TABLE public.ppa_portal_links ENABLE ROW LEVEL SECURITY; -- service role only
