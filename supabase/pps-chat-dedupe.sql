-- One lead = one bill (owner, 11/04/2026). A lead billed from chat and then
-- moved to Session Done, or also on the calendar, showed up twice.
-- A contact with a live chat bill no longer gets a self-booked or calendar row,
-- unless that row was itself charged (the money stays visible). Voiding the
-- chat bill brings the other row back. Applied in the views, so the table, the
-- drill-down, the Charge button and the Monday auto-charge all agree.
create or replace view ppa_chat_billed_contacts as
  select f.contact_id
  from ppa_charges c
  join ppa_chat_flags f on c.appt_id = 'chat:' || f.conversation_id
  where c.charged and not coalesce(c.excluded, false) and f.contact_id is not null
  union
  select o.contact_id
  from ppa_charges c
  join ghl_opportunities o on c.appt_id = 'chat:dc:' || o.id
  where c.charged and not coalesce(c.excluded, false) and o.contact_id is not null;
revoke all on ppa_chat_billed_contacts from anon, authenticated;

create or replace view ppa_selfbooked as
  select ('opp:'::text || o.id) as appt_id,
    o.owner_key,
    o.id as opp_id,
    o.contact_id,
    coalesce(nullif(c.contact_name, ''::text), nullif(o.name, ''::text), (o.raw #>> '{contact,name}'::text[]), (o.raw #>> '{contact,phone}'::text[])) as contact_name,
    coalesce(nullif(c.email, ''::text), (o.raw #>> '{contact,email}'::text[]), (o.raw #>> '{contact,phone}'::text[])) as email,
    m.stage_name,
    o.last_stage_change_at as done_at
  from ghl_opportunities o
    join ghl_stage_map m on m.location_id = o.location_id and m.stage_id = o.stage_id
    left join ghl_contacts c on c.id = o.contact_id
    left join ppa_config cfg on cfg.owner_key = o.owner_key
  where (m.stage_name ~* 'session[[:space:]]*(done|complete)'::text or m.stage_name ~* '(5|five)[[:space:]]*star|google[[:space:]]*review'::text)
    and o.contact_id is not null
    and o.last_stage_change_at >= '2026-08-01 00:00:00+00'::timestamptz
    and (cfg.pps_start is null or o.last_stage_change_at >= cfg.pps_start)
    and not exists (select 1 from ppa_deposit_contacts_mv dc where dc.contact_id = o.contact_id)
    and (
      not exists (select 1 from ppa_chat_billed_contacts b where b.contact_id = o.contact_id)
      or exists (select 1 from ppa_charges own where own.appt_id = 'opp:' || o.id and own.charged)
    );

create or replace view ppa_calendar_booked as
  select distinct on (a.contact_id) ('cal:'::text || a.id) as appt_id,
    a.owner_key,
    a.contact_id,
    a.start_time,
    a.status,
    a.title,
    c.contact_name,
    c.email
  from ghl_appointments a
    left join ghl_contacts c on c.id = a.contact_id
    left join ppa_config cfg on cfg.owner_key = a.owner_key
  where a.start_time >= '2026-08-01 00:00:00+00'::timestamptz
    and (cfg.pps_start is null or a.start_time >= cfg.pps_start)
    and coalesce(a.status, ''::text) ~* '^(confirmed|showed|new)$'::text
    and not exists (select 1 from ppa_deposit_contacts_mv dc where dc.contact_id = a.contact_id)
    and not exists (
      select 1 from ghl_opportunities o
        join ghl_stage_map m on m.location_id = o.location_id and m.stage_id = o.stage_id
      where o.contact_id = a.contact_id
        and (m.stage_name ~* 'session[[:space:]]*(done|complete)'::text or m.stage_name ~* '(5|five)[[:space:]]*star|google[[:space:]]*review'::text)
    )
    and (
      not exists (select 1 from ppa_chat_billed_contacts b where b.contact_id = a.contact_id)
      or exists (select 1 from ppa_charges own where own.appt_id = 'cal:' || a.id and own.charged)
    )
  order by a.contact_id, a.start_time;
