-- Leads who REPLIED and are still waiting on us, for the Cost/Deposit tab's
-- "conversations we could still close" review list (user request 2026-09-05).
--
-- "Replied" is read from last_message_direction = 'inbound': the lead's message
-- is the most recent one in the thread, so they answered and nobody has come
-- back to them. That is exactly the set worth reviewing by hand. (Only the LAST
-- message is mirrored per conversation, so threads where we already replied
-- after them cannot be identified without message-level data.)
--
-- friction_kind names what went wrong in the lead's last message (opt-out,
-- trust, broken, price, not interested, confused); NULL means an ordinary
-- reply. The review panel shows the rough ones by default (2026-09-06).
--
-- already_deposited flags leads who have since paid, matched on normalized name
-- within the same business — deposit rows carry a name but usually no email.
CREATE OR REPLACE VIEW public.cpd_open_conversations AS
WITH cpd AS (
  SELECT lower(trim(data->>'Owner Full Name')) AS owner_key,
         trim(data->>'Owner Full Name')        AS owner_name,
         trim(data->>'Business Name')          AS business
    FROM clients_master
   WHERE lower(trim(data->>'col_1')) IN ('live', 'paused')
     AND (lower(coalesce(data->>'Version', '')) LIKE '%v3%'
       OR lower(coalesce(data->>'Version', '')) LIKE '%v2.3%')
),
dep AS (
  SELECT DISTINCT
         lower(regexp_replace(coalesce(data->>'Business Name', ''), '[^a-zA-Z0-9]+', '', 'g')) AS biz_norm,
         lower(regexp_replace(coalesce(data->>'Full Name', ''),     '[^a-zA-Z0-9]+', '', 'g')) AS name_norm
    FROM deposits
   WHERE coalesce(data->>'Full Name', '') <> ''
)
SELECT c.id                                   AS conversation_id,
       c.location_id,
       c.owner_key,
       cpd.owner_name,
       cpd.business,
       c.contact_id,
       coalesce(nullif(ct.contact_name, ''), c.raw->>'contactName', c.raw->>'fullName', 'Unknown lead') AS lead_name,
       ct.email                               AS lead_email,
       ct.phone                               AS lead_phone,
       c.last_message_body,
       c.last_message_date,
       coalesce((c.raw->>'unreadCount')::int, 0) AS unread,
       (dep.name_norm IS NOT NULL)            AS already_deposited
  FROM ghl_conversations c
  JOIN cpd        ON cpd.owner_key = c.owner_key
  LEFT JOIN ghl_contacts ct ON ct.id = c.contact_id
  LEFT JOIN dep
         ON dep.biz_norm  = lower(regexp_replace(coalesce(cpd.business, ''), '[^a-zA-Z0-9]+', '', 'g'))
        AND dep.name_norm = lower(regexp_replace(coalesce(nullif(ct.contact_name, ''), c.raw->>'contactName', ''), '[^a-zA-Z0-9]+', '', 'g'))
 WHERE c.last_message_direction = 'inbound'
   AND c.last_message_date > now() - interval '14 days'
   AND coalesce(c.last_message_body, '') <> ''
   -- iMessage tapbacks are not a real reply.
   AND c.last_message_body !~* '^(liked|loved|laughed at|emphasized|disliked|questioned|removed)\s';
