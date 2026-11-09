-- 11/09/2026: appointments whose contact has no row in ghl_contacts, so the
-- deposit → contact → appointment link cannot close ("No appt" on the PPS tab).
-- Read by ingestAppointments() after each run to backfill those contacts.
CREATE OR REPLACE FUNCTION ppa_appointment_contacts_missing()
RETURNS TABLE (contact_id text, location_id text)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT DISTINCT a.contact_id, a.location_id
  FROM ghl_appointments a
  LEFT JOIN ghl_contacts c ON c.id = a.contact_id
  WHERE c.id IS NULL AND a.contact_id IS NOT NULL AND a.location_id IS NOT NULL
    AND coalesce(a.start_time, now()) >= now() - interval '120 days';
$$;
