-- One row per synced tab of the Facebook Campaign Stats workbook, so the
-- Performance tab can show each tab's own last sync and flag the one that
-- stalled. The old view read only cpl_7days, so a stale 14- or 30-day tab
-- stayed invisible behind a green badge.
CREATE OR REPLACE VIEW data_freshness AS
  SELECT 'cpl'::text AS key, max(synced_at) AS synced_at FROM cpl_7days
  UNION ALL SELECT 'cpl_7days',      max(synced_at) FROM cpl_7days
  UNION ALL SELECT 'cpl_14days',     max(synced_at) FROM cpl_14days
  UNION ALL SELECT 'cpl_30days',     max(synced_at) FROM cpl_30days
  UNION ALL SELECT 'campaign_spent', max(synced_at) FROM campaign_spent;
