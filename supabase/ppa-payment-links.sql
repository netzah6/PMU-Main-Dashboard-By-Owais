-- ── PPA payment links that mark themselves paid (11/10/2026) ─────────────────
-- Owner: "when we send them a link and they pay it, will that update the
-- system?" It did not — the link moved money but no show was marked, so the
-- Monday auto-charge / decline retries could collect the same shows again.
--
-- Every link made from the PPA Billing tab is stored here with its Square
-- ORDER id and the exact shows it covers. /api/cron/ppa-link-check (every 10
-- min, and right before any card charge) asks Square about THAT order id only
-- — never a name or amount match — so other Square payments (retainers,
-- deposits, subscriptions) can never be counted as PPA.
--
-- status: open → paid (all shows marked) | paid_review (money in, but some
--         shows were already charged/voided — a human decides; never an
--         automatic credit) | cancelled (shows charged on the card instead,
--         link deleted in Square so it can't be paid twice).
CREATE TABLE IF NOT EXISTS ppa_payment_links (
  id                bigserial PRIMARY KEY,
  owner_key         text NOT NULL,
  square_link_id    text NOT NULL,
  square_order_id   text NOT NULL UNIQUE,
  url               text NOT NULL,
  amount_cents      int  NOT NULL,
  fee               numeric NOT NULL,
  credit_applied    numeric NOT NULL DEFAULT 0, -- always 0: links never use account credit
  shows             jsonb NOT NULL,          -- [{ "appt_id": "...", "name": "..." }]
  status            text NOT NULL DEFAULT 'open',
  square_payment_id text,
  paid_at           timestamptz,
  review_note       text,
  last_error        text,
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ppa_payment_links_open_idx ON ppa_payment_links (owner_key) WHERE status = 'open';
ALTER TABLE ppa_payment_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "PPA payment links admin" ON ppa_payment_links;
CREATE POLICY "PPA payment links admin" ON ppa_payment_links FOR ALL TO authenticated
  USING (get_user_role() = 'admin') WITH CHECK (get_user_role() = 'admin');
