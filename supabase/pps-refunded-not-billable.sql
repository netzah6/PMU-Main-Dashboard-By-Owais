-- A refunded deposit is never billed (owner, 11/09/2026): "If we refunded
-- them it means the client didn't do the appointment." Before this, only the
-- drill-down knew about refunds (by email or name, any date), so the Ready
-- count, the Charge button and the Monday auto-charge still billed them
-- (e.g. Stacey Posey: 3 ready, 1 on her list).
--
-- One rule, in the view every billing path reads, so all of them agree.
-- A deposit is refunded when an executed refund has the SAME business, email
-- and deposit date. Copies of one sheet row (Make writing the same payment
-- twice) share one appt_id and count as ONE deposit. Two real deposits on
-- the same day with only one refunded: she still has a deposit, so it bills.

create or replace view ppa_refunded_deposits as
 WITH dep_keys AS (
   SELECT r.biz_norm AS bn, lower(btrim(COALESCE(r.email, ''))) AS em, btrim(COALESCE(r.deposit_date, '')) AS dd, count(DISTINCT r.appt_id) AS n_dep
     FROM ppa_deposit_rows r
    GROUP BY 1, 2, 3
 ), ref_keys AS (
   SELECT lower(regexp_replace(COALESCE(x.business, ''), '[^a-zA-Z0-9]', '', 'g')) AS bn,
          lower(btrim(COALESCE(x.email, ''))) AS em, btrim(COALESCE(x.deposit_date, '')) AS dd,
          count(*) AS n_ref, max(x.decided_at) AS refunded_at
     FROM deposit_refunds x
    WHERE x.status = 'refunded'
    GROUP BY 1, 2, 3
 )
 SELECT DISTINCT ON (r.appt_id) r.appt_id, k.refunded_at
   FROM ppa_deposit_rows r
   JOIN dep_keys d ON d.bn = r.biz_norm AND d.em = lower(btrim(COALESCE(r.email, ''))) AND d.dd = btrim(COALESCE(r.deposit_date, ''))
   JOIN ref_keys k ON k.bn = d.bn AND k.em = d.em AND k.dd = d.dd
  WHERE k.n_ref >= d.n_dep
  ORDER BY r.appt_id;

-- Same as pps-start-date.sql plus the 'refunded' branch (right after
-- 'before_start', so retainer-era history keeps its own label).
create or replace view ppa_deposit_billing as
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
    END AS charge_status
   FROM ppa_deposit_facts f
   LEFT JOIN ppa_config cfg ON cfg.owner_key = f.owner_key;

-- Views stay server and signed-in only (see views-access-grants.sql).
revoke all on public.ppa_refunded_deposits from anon;
