-- Cost/Deposit "problems found" panel (IssuesPanel on /cost-per-deposit).
-- Rule-based, no LLM: a price-sanity check plus a keyword scan of the last
-- inbound client message. Dismissals live in issue_dismissals (team-wide).
--
-- Rewritten 2026-09-05 after three false positives on the live board:
--  1. PRICE PARSE. The old rule stripped every non-digit from the price
--     strings, so "$435 for new brows and $375 for annual touch ups" became
--     435375 — larger than the $635 original — and Joanel Bernardo was flagged
--     as "swapped" when her prices were fine. Numbers are now read properly and
--     a swap means the original sits BELOW the highest discounted price; the
--     original should always be the higher number.
--  2. V3 ONLY. The panel exists to find AI-bot bugs, so it covers V3 clients
--     only (V2.3 excluded — note "v2.3" does not contain "v3").
--  3. COMPLAINT RULES. "I apologize for any grammar errors as I'm verbally
--     texting and driving" matched the bare word "error"; "You need to stop
--     texting me" matched "stop text" though nothing was broken. Bare "error"
--     now needs system context, apologies about the lead's own typing are
--     excluded, and irritation at being texted is not a bug by itself.
CREATE OR REPLACE VIEW public.cpd_issues AS
WITH live AS (
  SELECT lower(trim(data->>'Owner Full Name')) AS ok,
         trim(data->>'Business Name') AS biz
    FROM clients_master
   WHERE lower(trim(data->>'col_1')) = 'live'
     AND replace(lower(coalesce(data->>'Version','')), ' ', '') LIKE '%v3%'
),
prices AS (
  SELECT o.owner_name,
         o.original_price,
         o.discounted_price,
         (SELECT max(m[1]::numeric) FROM regexp_matches(o.original_price,   '[0-9]+(?:\.[0-9]+)?', 'g') AS m) AS orig_max,
         (SELECT max(m[1]::numeric) FROM regexp_matches(o.discounted_price, '[0-9]+(?:\.[0-9]+)?', 'g') AS m) AS disc_max
    FROM deposit_overview o
   WHERE replace(lower(coalesce(o.version,'')), ' ', '') LIKE '%v3%'
)
SELECT 'price_swap:' || lower(p.owner_name) AS fingerprint,
       'price_swap'::text                   AS kind,
       p.owner_name                         AS who,
       'Original ' || p.original_price || ' is LOWER than discounted '
         || p.discounted_price || ' — the two values look swapped.' AS detail,
       NULL::text AS location_id,
       NULL::text AS contact_id,
       now()      AS seen_at
  FROM prices p
 WHERE p.orig_max IS NOT NULL
   AND p.disc_max IS NOT NULL
   AND p.orig_max < p.disc_max

UNION ALL

SELECT 'complaint:' || c.id AS fingerprint,
       'complaint'::text    AS kind,
       l.biz || ' — ' || coalesce(nullif(ct.contact_name,''), c.contact_id) AS who,
       left(c.last_message_body, 220) AS detail,
       c.location_id,
       c.contact_id,
       c.last_message_date AS seen_at
  FROM ghl_conversations c
  JOIN live l ON l.ok = c.owner_key
  LEFT JOIN ghl_contacts ct ON ct.id = c.contact_id
 WHERE c.last_message_direction = 'inbound'
   AND c.last_message_date > now() - interval '3 days'
   -- iMessage tapbacks ("Liked "your link is broken"") quote the original text.
   AND c.last_message_body !~* '^(liked|loved|laughed at|emphasized|disliked|questioned|removed)\s'
   -- The lead apologising for THEIR OWN typing is not our bug.
   AND c.last_message_body !~* '(apolog|sorry).{0,40}(typo|grammar|spell|error)'
   AND c.last_message_body !~* '(voice|verbal|talk|speech)[ -]?(to[ -]?)?text|autocorrect|swyp|fat finger'
   -- Something on our side actually misbehaved.
   AND c.last_message_body ~* (
        '(not? work|doesn''t work|didn''t work|won''t (work|let|load|open)'
     || '|can''t (book|pay|open|click|access|submit)|cannot (book|pay|open|submit)'
     || '|(error|problem|issue) (message|occurred|when|while|with|loading|booking|paying)'
     || '|(getting|got|keep getting|there''s|theres|an) (an )?error'
     || '|link (is )?(broken|dead|expired|not work|doesn''t work)|page (is )?(broken|blank|not load)'
     || '|broken|invalid|expired|already (paid|charged)|charged (twice|2|two)|double charge'
     || '|wrong (link|number|time|date|price|name)|confus|glitch|scam'
     || '|is this a (bot|robot|real person)|are you (a )?(bot|robot|real)|talking to a (bot|robot|computer)'
     || '|real person|refund)'
   );
