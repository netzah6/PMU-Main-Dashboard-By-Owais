-- One visit = one PPA fee (owner, 11/11/2026).
-- Billing used to count one fee per DEPOSIT. A lead who paid two deposits
-- for the same visit (the AI booked a second appointment and took a second
-- deposit — Kelly Winston: 09/17 + 11/07, one 11/08 visit) showed as two
-- Ready shows and could be charged twice. ppa_deposit_appointment ties every
-- deposit of a contact to that contact's latest appointment, so the two
-- deposits share one start_time.
--
-- Rule: deposits of the same lead (same name OR same email) for the same
-- appointment (same owner + same start_time) bill ONCE. The keeper is, in
-- order: the one already charged, then one not excluded, then the earliest
-- deposit, then the lowest appt_id. The others get charge_status
-- 'duplicate', which no billing path charges. Refunded and before-start
-- deposits never take part, so if the keeper is later refunded the next one
-- takes over and the visit still bills once. Rows already charged keep their
-- charge — history doesn't change, nothing is credited.
--
-- Same as pps-refunded-not-billable.sql, with the duplicate step added.

create or replace view ppa_deposit_billing as
 WITH base AS (
   SELECT f.appt_id, f.owner_key, f.stage_name, f.is_session_done, f.is_five_star, f."position", f.start_time, f.appt_status,
     CASE
       WHEN cfg.pps_start IS NOT NULL
        AND COALESCE(f.start_time, (SELECT pps_parse_date(r.deposit_date) FROM ppa_deposit_rows r WHERE r.appt_id = f.appt_id LIMIT 1)) < cfg.pps_start
         THEN 'before_start'::text
       WHEN f.appt_id IN (SELECT rd.appt_id FROM ppa_refunded_deposits rd) THEN 'refunded'::text
       WHEN (f.is_session_done OR f.is_five_star) THEN 'served'::text
       WHEN ((f.start_time IS NOT NULL) AND (lower(COALESCE(f.appt_status, ''::text)) ~ 'cancel|noshow|no-show|invalid'::text)) THEN 'noshow'::text
       WHEN (f.stage_name ~* 'declin'::text) THEN 'declining'::text
       WHEN ((f.start_time IS NOT NULL) AND (f.start_time > now())) THEN 'upcoming'::text
       WHEN ((f.start_time IS NOT NULL) AND (f.start_time <= now())) THEN 'past_due'::text
       ELSE 'no_appt'::text
     END AS status0
   FROM ppa_deposit_facts f
   LEFT JOIN ppa_config cfg ON cfg.owner_key = f.owner_key
 ), lead AS (
   SELECT DISTINCT ON (r.appt_id) r.appt_id,
          lower(btrim(COALESCE(r.contact_name, ''))) AS nm,
          lower(btrim(COALESCE(r.email, ''))) AS em,
          pps_parse_date(r.deposit_date) AS dep_at
     FROM ppa_deposit_rows r
    ORDER BY r.appt_id
 ), cand AS (
   SELECT b.appt_id, b.owner_key, b.start_time, l.nm, l.em,
          -- keeper rank: lower wins (charged first, then not excluded, then earliest deposit, then appt_id)
          ROW(NOT COALESCE(ch.charged, false), COALESCE(ch.excluded, false),
              COALESCE(l.dep_at, 'infinity'::timestamptz), b.appt_id) AS rk
     FROM base b
     JOIN lead l ON l.appt_id = b.appt_id
     LEFT JOIN ppa_charges ch ON ch.appt_id = b.appt_id
    WHERE b.start_time IS NOT NULL
      AND b.status0 NOT IN ('before_start', 'refunded')
 ), dup AS (
   SELECT DISTINCT me.appt_id
     FROM cand me
     JOIN cand o ON o.owner_key = me.owner_key AND o.start_time = me.start_time AND o.appt_id <> me.appt_id
                AND ((me.nm <> '' AND o.nm = me.nm) OR (me.em <> '' AND o.em = me.em))
    WHERE o.rk < me.rk
 )
 SELECT b.appt_id, b.owner_key, b.stage_name, b.is_session_done, b.is_five_star, b."position", b.start_time, b.appt_status,
        CASE WHEN b.appt_id IN (SELECT appt_id FROM dup) THEN 'duplicate'::text ELSE b.status0 END AS charge_status
   FROM base b;

-- Views stay server and signed-in only (see views-access-grants.sql).
revoke all on public.ppa_deposit_billing from anon;
