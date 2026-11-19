import type { createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken } from "@/lib/ghl-app";
import { getSurveyFieldMap, fmtReservedTime } from "@/lib/onebox";
import { addOneboxBookedTag, artistAlreadyNotified, ensureContactOwner } from "@/lib/artist-notify";

type Svc = ReturnType<typeof createServiceClient>;

/* Every PAID booking texts the artist — not only the ones the funnel booked
   (owner 11/18/2026, Rosario Ramos / Modern Artistry). The funnel adds the
   "onebox-booked" tag itself; when the AI (CloseBot) or anything else books
   a paid client, nothing did, so the artist never got her "New appointment
   secured!" text (the old step that covered it was removed on 09/28).

   Source of truth for "she paid" = paid_tag_checks (one row per deposit,
   with the GHL contact). For each payment of the last 21 days:
   - the funnel already told the artist (onebox_leads.artist_notified_at)  → funnel_notified
   - no future appointment yet                                             → stays pending, looked at again
   - the appointment was made by a person in GHL (the artist knows)       → artist_booked
   - the artist's thread already has a "secured" text naming her          → already_texted
   - otherwise: write the reserved-time field the text reads, make sure
     the contact has an owner, add "onebox-booked" → the account's
     "CC - One-Box Booking -> Notify Artist" workflow texts the artist      → notified
   One row per payment in artist_booking_notices, so nobody is texted twice. */

const WINDOW_DAYS = 21;
const PER_RUN = 12; // GHL lookups per run (each = 1–4 calls)

type Appt = { id: string; startTime?: string; appointmentStatus?: string; dateAdded?: string; createdBy?: { source?: string; userId?: string | null } };

const startMs = (a: Appt) => Date.parse(String(a.startTime ?? "").replace(" ", "T"));

export async function notifyPaidBookings(svc: Svc, opts: { dryRun?: boolean; limit?: number } = {}): Promise<{ looked: number; notified: string[]; skipped: string[]; pending: number; errors: string[] }> {
  const since = new Date(Date.now() - WINDOW_DAYS * 86400_000).toISOString();
  const { data: pays } = await svc.from("paid_tag_checks").select("key, location_id, contact_id, checked_at")
    .in("result", ["ok", "healed"]).not("contact_id", "is", null).gte("checked_at", since).order("checked_at");
  const { data: done } = await svc.from("artist_booking_notices").select("key, result, attempts, updated_at");
  const closed = new Map((done ?? []).map((d) => [d.key as string, d]));
  const out = { looked: 0, notified: [] as string[], skipped: [] as string[], pending: 0, errors: [] as string[] };

  // Pending rows are looked at again at most every 30 min; closed rows never.
  const due = (pays ?? []).filter((p) => {
    const d = closed.get(p.key as string);
    if (!d) return true;
    if (d.result !== "pending" && d.result !== "failed") return false;
    if (d.result === "failed" && (d.attempts as number) >= 5) return false;
    return Date.now() - Date.parse(String(d.updated_at)) > 30 * 60_000;
  });
  out.pending = due.length;

  const save = async (key: string, row: Record<string, unknown>) => {
    if (opts.dryRun) return;
    const prev = closed.get(key);
    await svc.from("artist_booking_notices").upsert({ key, ...row, attempts: ((prev?.attempts as number) ?? 0) + 1, updated_at: new Date().toISOString() });
  };

  for (const p of due.slice(0, opts.limit ?? PER_RUN)) {
    const key = p.key as string, loc = p.location_id as string, contactId = p.contact_id as string;
    out.looked++;
    try {
      const paidMs = Date.parse(String(p.checked_at));
      // The funnel already told her about this booking.
      const { data: ob } = await svc.from("onebox_leads").select("artist_notified_at").eq("ghl_contact_id", contactId)
        .not("artist_notified_at", "is", null).gte("artist_notified_at", new Date(paidMs - 3 * 86400_000).toISOString()).limit(1);
      if (ob?.length) { await save(key, { location_id: loc, contact_id: contactId, result: "funnel_notified" }); out.skipped.push(`${key}: funnel already told the artist`); continue; }

      const tok = (await getAppLocationToken(loc)).token;
      if (!tok) { await save(key, { location_id: loc, contact_id: contactId, result: "failed", note: "no location token" }); out.errors.push(`${key}: no token`); continue; }
      const H = { Authorization: `Bearer ${tok}`, Version: "2021-04-15", Accept: "application/json", "Content-Type": "application/json" };
      const ar = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/appointments`, { headers: H });
      if (!ar.ok) { await save(key, { location_id: loc, contact_id: contactId, result: "failed", note: `appointments ${ar.status}` }); out.errors.push(`${key}: appointments ${ar.status}`); continue; }
      // This list gives local times without a zone — keep anything that may still be ahead (1-day slack),
      // then read the appointment itself for its exact time (with offset) and who made it.
      const listed = (((await ar.json()) as { events?: Appt[] }).events ?? [])
        .filter((a) => startMs(a) > Date.now() - 86400_000 && !/cancel|noshow|invalid/i.test(String(a.appointmentStatus ?? "")))
        .sort((a, b) => startMs(a) - startMs(b));
      let appt: Appt | undefined;
      for (const l of listed) {
        const dr = await fetch(`https://services.leadconnectorhq.com/calendars/events/appointments/${l.id}`, { headers: H });
        const d = dr.ok ? (((await dr.json()) as { appointment?: Appt; event?: Appt }).appointment ?? undefined) : undefined;
        const full: Appt = { ...l, ...(d ?? {}), id: l.id };
        if (startMs(full) > Date.now()) { appt = full; break; }
      }
      if (!appt) {
        // No booking yet (the AI may still book her) — look again later, until the window ends.
        await save(key, { location_id: loc, contact_id: contactId, result: "pending", note: "no future confirmed appointment yet" });
        continue;
      }
      const base = { location_id: loc, contact_id: contactId, appointment_id: appt.id, start_time: appt.startTime ?? null };
      // Booked by a person in GHL (the artist's own app or screen): she knows.
      if (appt.createdBy?.userId) { await save(key, { ...base, result: "artist_booked" }); out.skipped.push(`${key}: booked by a person in GHL`); continue; }

      const cr = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, { headers: { ...H, Version: "2021-07-28" } });
      const contact = cr.ok ? (((await cr.json()) as { contact?: { firstName?: string; lastName?: string; contactName?: string; name?: string } }).contact ?? {}) : {};
      const name = String(contact.contactName ?? contact.name ?? `${contact.firstName ?? ""} ${contact.lastName ?? ""}`).trim();
      // An old leftover step may already have texted her (Susan's account had one until 11/06).
      if (name) {
        const already = await artistAlreadyNotified(loc, name);
        if (already.notified) { await save(key, { ...base, result: "already_texted" }); out.skipped.push(`${key}: artist already has a "secured" text for ${name}`); continue; }
      }
      if (opts.dryRun) { out.notified.push(`${key} → ${name} ${appt.startTime} (dry run)`); continue; }

      // The text reads the time from "CC - Reserved Appointment Time" — fill it first.
      const fieldMap = await getSurveyFieldMap(loc, tok);
      const iso = String(appt.startTime ?? "");
      if (fieldMap.reserved_time && iso) {
        await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
          method: "PUT", headers: { ...H, Version: "2021-07-28" },
          body: JSON.stringify({ customFields: [{ id: fieldMap.reserved_time, value: fmtReservedTime(iso) }] }),
        });
      }
      await ensureContactOwner(loc, contactId);
      const tagged = await addOneboxBookedTag(loc, contactId);
      if (tagged.ok) { await save(key, { ...base, result: "notified", note: "onebox-booked tag added — GHL workflow texts the artist" }); out.notified.push(`${key} → ${name} ${iso}`); }
      else { await save(key, { ...base, result: "failed", note: tagged.note }); out.errors.push(`${key}: ${tagged.note}`); }
    } catch (e) {
      out.errors.push(`${key}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
    }
  }
  return out;
}
