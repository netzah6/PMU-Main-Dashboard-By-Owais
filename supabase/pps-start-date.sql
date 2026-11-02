-- PPS start date per client (owner, 11/02/2026): a client who switched to
-- pay-per-show on a given date is only billed for appointments from then on.
-- NULL = all time (the default). Applies in the views, so the table, the
-- drill-down, the Charge button and the Monday auto-charge all agree.
alter table ppa_config add column if not exists pps_start timestamptz;

-- Deposit dates arrive as ISO (webhook) or DD/MM/YYYY (sheet era).
create or replace function pps_parse_date(t text) returns timestamptz
language plpgsql immutable as $$
begin
  if t is null or btrim(t) = '' then return null; end if;
  if t ~ '^\d{4}-\d{2}-\d{2}' then return t::timestamptz; end if;
  if t ~ '^\d{1,2}/\d{1,2}/\d{4}' then return to_date(substring(t from '^\d{1,2}/\d{1,2}/\d{4}'), 'DD/MM/YYYY')::timestamptz; end if;
  return null;
exception when others then return null;
end $$;

-- Deposits: dated by the appointment, else by the deposit itself. Anything
-- before the client's start date becomes 'before_start' and never bills.
create or replace view ppa_deposit_billing as
 SELECT f.appt_id, f.owner_key, f.stage_name, f.is_session_done, f.is_five_star, f."position", f.start_time, f.appt_status,
    CASE
      WHEN cfg.pps_start IS NOT NULL
       AND COALESCE(f.start_time, (SELECT pps_parse_date(r.deposit_date) FROM ppa_deposit_rows r WHERE r.appt_id = f.appt_id LIMIT 1)) < cfg.pps_start
        THEN 'before_start'::text
      WHEN (f.is_session_done OR f.is_five_star) THEN 'served'::text
      WHEN ((f.start_time IS NOT NULL) AND (lower(COALESCE(f.appt_status, ''::text)) ~ 'cancel|noshow|no-show|invalid'::text)) THEN 'noshow'::text
      WHEN (f.stage_name ~* 'declin'::text) THEN 'declining'::text
      WHEN ((f.start_time IS NOT NULL) AND (f.start_time > now())) THEN 'upcoming'::text
      WHEN ((f.start_time IS NOT NULL) AND (f.start_time <= now())) THEN 'past_due'::text
      ELSE 'no_appt'::text
    END AS charge_status
   FROM ppa_deposit_facts f
   LEFT JOIN ppa_config cfg ON cfg.owner_key = f.owner_key;

create or replace view ppa_selfbooked as
 SELECT ('opp:'::text || o.id) AS appt_id, o.owner_key, o.id AS opp_id, o.contact_id,
    COALESCE(NULLIF(c.contact_name, ''::text), NULLIF(o.name, ''::text), (o.raw #>> '{contact,name}'::text[]), (o.raw #>> '{contact,phone}'::text[])) AS contact_name,
    COALESCE(NULLIF(c.email, ''::text), (o.raw #>> '{contact,email}'::text[]), (o.raw #>> '{contact,phone}'::text[])) AS email,
    m.stage_name, o.last_stage_change_at AS done_at
   FROM ghl_opportunities o
     JOIN ghl_stage_map m ON m.location_id = o.location_id AND m.stage_id = o.stage_id
     LEFT JOIN ghl_contacts c ON c.id = o.contact_id
     LEFT JOIN ppa_config cfg ON cfg.owner_key = o.owner_key
  WHERE (m.stage_name ~* 'session[[:space:]]*(done|complete)'::text OR m.stage_name ~* '(5|five)[[:space:]]*star|google[[:space:]]*review'::text)
    AND o.contact_id IS NOT NULL
    AND o.last_stage_change_at >= '2026-08-01 00:00:00+00'::timestamptz
    AND (cfg.pps_start IS NULL OR o.last_stage_change_at >= cfg.pps_start)
    AND NOT EXISTS (SELECT 1 FROM ppa_deposit_contacts_mv dc WHERE dc.contact_id = o.contact_id);

create or replace view ppa_calendar_booked as
 SELECT DISTINCT ON (a.contact_id) ('cal:'::text || a.id) AS appt_id, a.owner_key, a.contact_id, a.start_time, a.status, a.title, c.contact_name, c.email
   FROM ghl_appointments a
     LEFT JOIN ghl_contacts c ON c.id = a.contact_id
     LEFT JOIN ppa_config cfg ON cfg.owner_key = a.owner_key
  WHERE a.start_time >= '2026-08-01 00:00:00+00'::timestamptz
    AND (cfg.pps_start IS NULL OR a.start_time >= cfg.pps_start)
    AND COALESCE(a.status, ''::text) ~* '^(confirmed|showed|new)$'::text
    AND NOT EXISTS (SELECT 1 FROM ppa_deposit_contacts_mv dc WHERE dc.contact_id = a.contact_id)
    AND NOT EXISTS (SELECT 1 FROM ghl_opportunities o JOIN ghl_stage_map m ON m.location_id = o.location_id AND m.stage_id = o.stage_id
          WHERE o.contact_id = a.contact_id AND (m.stage_name ~* 'session[[:space:]]*(done|complete)'::text OR m.stage_name ~* '(5|five)[[:space:]]*star|google[[:space:]]*review'::text))
  ORDER BY a.contact_id, a.start_time;
