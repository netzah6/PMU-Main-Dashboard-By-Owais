-- "Refund, but keep the PPA fee" (owner, 11/11/2026).
-- Normally a refunded deposit is never billed (pps-refunded-not-billable.sql:
-- "If we refunded them it means the client didn't do the appointment").
-- Sometimes the lead DID come and the deposit is refunded for another reason
-- (e.g. the AI booked a second appointment and took a second deposit for a
-- client the artist had already booked herself). For V3 pay-per-appointment
-- clients the admin can now approve the refund and still bill the service fee.
--
-- keep_ppa_fee = true  -> the refund still happens (money goes back to the
--                         lead) but the deposit stays billable on PPA Billing.
-- keep_ppa_fee = false -> today's behaviour (refunded = never billed).

alter table public.deposit_refunds
  add column if not exists keep_ppa_fee boolean not null default false;

-- Same view as pps-refunded-not-billable.sql, plus "and not keep_ppa_fee" in
-- ref_keys: a keep-fee refund no longer counts as a refund for billing.
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
      AND NOT x.keep_ppa_fee
    GROUP BY 1, 2, 3
 )
 SELECT DISTINCT ON (r.appt_id) r.appt_id, k.refunded_at
   FROM ppa_deposit_rows r
   JOIN dep_keys d ON d.bn = r.biz_norm AND d.em = lower(btrim(COALESCE(r.email, ''))) AND d.dd = btrim(COALESCE(r.deposit_date, ''))
   JOIN ref_keys k ON k.bn = d.bn AND k.em = d.em AND k.dd = d.dd
  WHERE k.n_ref >= d.n_dep
  ORDER BY r.appt_id;

-- Views stay server and signed-in only (see views-access-grants.sql).
revoke all on public.ppa_refunded_deposits from anon;
