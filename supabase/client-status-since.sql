-- When each client's Clients-sheet status (col_1) last changed to a non-Live
-- value, as first seen by the alerts scan. "Leads but not Live" waits 3 days
-- from this moment before telling the coach (owner, 11/11/2026): a coach who
-- just paused a client needs time for the ads to stop.
CREATE TABLE IF NOT EXISTS public.client_status_since (
  biz_key    text PRIMARY KEY,          -- lower(trim(Business Name))
  status     text NOT NULL,
  since      timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.client_status_since ENABLE ROW LEVEL SECURITY; -- service role only
