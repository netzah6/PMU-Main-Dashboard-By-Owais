-- ── V3 Pay-Per-Appointment billing ───────────────────────────────────────────
-- Applied to Supabase (project heglznxmldngkfqwvjvx) via migrations
-- v3_ppa_billing + v3_ppa_deposit_rows. Kept here for version control.
-- Dashboard-only state (never written back to Google Sheets).

-- Per-client billing config: which V3 clients are pay-per-appointment + their fee.
CREATE TABLE IF NOT EXISTS ppa_config (
  owner_key    TEXT PRIMARY KEY,
  is_ppa       BOOLEAN NOT NULL DEFAULT false,
  fee_per_appt NUMERIC NOT NULL DEFAULT 30,
  note         TEXT,
  updated_at   TIMESTAMPTZ DEFAULT now(),
  updated_by   TEXT
);

-- The tracker: one row per appointment (deposit) we have (or haven't) charged.
-- appt_id is a stable content hash of the deposit (business|contact|date|amount).
CREATE TABLE IF NOT EXISTS ppa_charges (
  appt_id     TEXT PRIMARY KEY,
  owner_key   TEXT NOT NULL,
  charged     BOOLEAN NOT NULL DEFAULT false,
  amount      NUMERIC,
  note        TEXT,
  charged_at  TIMESTAMPTZ,
  charged_by  TEXT,
  updated_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ppa_charges_owner_idx ON ppa_charges (owner_key);

-- Cache of GHL pipeline stage names per location (names aren't stored on
-- ghl_opportunities). Warmed by the GHL ingest + on-demand on first tab load.
CREATE TABLE IF NOT EXISTS ghl_stage_map (
  location_id TEXT NOT NULL,
  stage_id    TEXT NOT NULL,
  pipeline_id TEXT,
  stage_name  TEXT,
  position    INT,
  updated_at  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (location_id, stage_id)
);

-- ── RLS: admin-only (only the owner has the admin role) ──────────────────────
ALTER TABLE ppa_config    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ppa_charges   ENABLE ROW LEVEL SECURITY;
ALTER TABLE ghl_stage_map ENABLE ROW LEVEL SECURITY;

CREATE POLICY "PPA config admin" ON ppa_config   FOR ALL TO authenticated
  USING (get_user_role() = 'admin') WITH CHECK (get_user_role() = 'admin');
CREATE POLICY "PPA charges admin" ON ppa_charges FOR ALL TO authenticated
  USING (get_user_role() = 'admin') WITH CHECK (get_user_role() = 'admin');
CREATE POLICY "Stage map read" ON ghl_stage_map  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Stage map admin write" ON ghl_stage_map FOR ALL TO authenticated
  USING (get_user_role() = 'admin') WITH CHECK (get_user_role() = 'admin');

-- ── Aggregate views (read by the billing API via the service client) ─────────

-- Per-client pipeline stage counts, classifying stages by name.
CREATE OR REPLACE VIEW ppa_stage_counts AS
SELECT
  o.owner_key,
  max(o.location_id)                                                          AS location_id,
  count(*)                                                                    AS total_opps,
  count(*) FILTER (WHERE m.stage_name ~* 'session[[:space:]]*(done|complete)') AS session_done,
  count(*) FILTER (WHERE m.stage_name ~* '(5|five)[[:space:]]*star|google[[:space:]]*review') AS five_star,
  count(*) FILTER (WHERE m.stage_name ~* 'deposit')                            AS deposit_stage,
  count(*) FILTER (WHERE m.position = 0)                                       AS first_stage,
  count(*) FILTER (WHERE m.stage_id IS NULL)                                   AS unmapped
FROM ghl_opportunities o
LEFT JOIN ghl_stage_map m
  ON m.location_id = o.location_id AND m.stage_id = o.stage_id
GROUP BY o.owner_key;

-- Per-business deposit counts (deposits join clients by Business Name).
CREATE OR REPLACE VIEW ppa_deposit_counts AS
SELECT
  lower(regexp_replace(coalesce(data->>'Business Name',''), '[^a-zA-Z0-9]', '', 'g')) AS biz_norm,
  count(*) AS deposits,
  sum(nullif(regexp_replace(coalesce(data->>'Amount',''), '[^0-9.]', '', 'g'), '')::numeric) AS deposit_total
FROM deposits
WHERE coalesce(data->>'Business Name','') <> ''
GROUP BY 1;

-- Per-deposit rows with a stable content-hash id (the tracker keys on appt_id).
CREATE OR REPLACE VIEW ppa_deposit_rows AS
SELECT
  'd_' || substr(md5(
    lower(trim(coalesce(data->>'Business Name',''))) || '|' ||
    lower(trim(coalesce(data->>'Full Name',''))) || '|' ||
    lower(trim(coalesce(data->>'Email',''))) || '|' ||
    lower(trim(coalesce(data->>'Date', data->>'f',''))) || '|' ||
    lower(trim(coalesce(data->>'Amount','')))
  ), 1, 20) AS appt_id,
  lower(regexp_replace(coalesce(data->>'Business Name',''), '[^a-zA-Z0-9]', '', 'g')) AS biz_norm,
  data->>'Business Name' AS business,
  data->>'Full Name'     AS contact_name,
  data->>'Email'         AS email,
  coalesce(data->>'Date', data->>'f') AS deposit_date,
  data->>'Amount'        AS amount,
  data->>'Status'        AS status,
  data->>'Notes'         AS notes,
  data->>'Source'        AS source
FROM deposits
WHERE coalesce(data->>'Business Name','') <> '';