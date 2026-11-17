import { AI_HOLD_LIVE_MS, AI_HOLD_STATUS, locationTimezone, wallToIso } from "@/lib/onebox";
import { REMOVED_TAG } from "@/lib/ai-hold-cleanup";

const GHL = "https://services.leadconnectorhq.com";

/* Look before a server job books a PAID lead's picked time (11/17/2026).

   The two safety nets (paid-tag-heal every 10 min, ghl-retry every 30 min)
   act long after the lead left the page, so they must never undo what a
   person did in between. They book only the clean case: nobody has touched
   her calendar since she picked. Everything else is left alone or handed to
   a person through an Alerts card.

   - same_time     a live appointment already sits at her picked time
   - other_time    she has a live appointment at ANOTHER time (the artist or
                   the AI set it): leave it; /api/onebox/book would cancel it
   - needs_person  no live appointment, but one was made or changed after she
                   picked and is gone now (cancelled, or deleted: a deleted
                   appointment is invisible to the appointments API, so the
                   conversation's own appointment activity is read too)
   - none          nothing was ever booked for her: book the picked time

   Fails closed: any unreadable piece is an error, never "no appointments"
   (a failed lookup that read as "nothing there" is how the double bookings
   of 10/19 happened). */
export type PaidBookingLook =
  | { ok: true; state: "none" | "same_time" | "other_time" | "needs_person"; note: string }
  | { ok: false; error: string };

type Ev = { id?: string; startTime?: string; dateAdded?: string; appointmentStatus?: string; appoinmentStatus?: string; deleted?: boolean };

export async function lookBeforePaidBooking(a: {
  locationId: string; token: string; contactId: string; slotIso: string;
  /** When she picked the time (onebox_leads.picked_time_at, else created_at). */
  pickedAt?: string | null;
}): Promise<PaidBookingLook> {
  try {
    const H = { Authorization: `Bearer ${a.token}`, Accept: "application/json" };
    const cid = encodeURIComponent(a.contactId);
    const [tz, ar] = await Promise.all([
      locationTimezone(a.locationId, a.token),
      fetch(`${GHL}/contacts/${cid}/appointments`, { headers: { ...H, Version: "2021-07-28" } }),
    ]);
    if (!ar.ok) return { ok: false, error: `appointments HTTP ${ar.status}` };
    if (!tz) return { ok: false, error: "location timezone unknown" };
    const events = ((await ar.json()) as { events?: Ev[] }).events ?? [];

    const now = Date.now();
    // GHL gives startTime and dateAdded as the studio's wall clock (no offset).
    const ms = (wall: unknown) => Date.parse(wallToIso(String(wall ?? ""), tz));
    const offsetLess = !/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(a.slotIso);
    const slotMs = Date.parse(offsetLess ? wallToIso(a.slotIso, tz) : a.slotIso);
    if (!Number.isFinite(slotMs)) return { ok: false, error: "picked time unreadable" };
    const rows = events.filter((e) => e.id).map((e) => {
      const status = String(e.appointmentStatus ?? e.appoinmentStatus ?? "").toLowerCase(); // GHL ships both spellings
      return { startMs: ms(e.startTime), addedMs: ms(e.dateAdded), status, gone: e.deleted === true || status === "cancelled" };
    });
    const ahead = rows.filter((r) => !r.gone && r.status !== "noshow" && r.status !== "showed" && Number.isFinite(r.startMs) && r.startMs > now);
    if (ahead.some((r) => Math.abs(r.startMs - slotMs) < 60_000)) {
      return { ok: true, state: "same_time", note: "an appointment already sits at her picked time" };
    }
    /* "invalid" is the AI's unpaid hold: the account's own workflow confirms
       it once the paid tag lands, but only for a few days. An older hold at
       another time is dead (nothing will ever confirm it) and must not count
       as "she has an appointment", or a paying lead is left with nothing. */
    const live = ahead.filter((r) => !(r.status === AI_HOLD_STATUS && Number.isFinite(r.addedMs) && r.addedMs < now - AI_HOLD_LIVE_MS));
    if (live.length) return { ok: true, state: "other_time", note: "she already has an appointment at another time" };

    // Nothing live. Was anything made for her after she picked?
    const pickedMs = Date.parse(String(a.pickedAt ?? ""));
    const since = Number.isFinite(pickedMs) ? pickedMs - 5 * 60_000 : now - 21 * 86_400_000;
    const cr = await fetch(`${GHL}/contacts/${cid}`, { headers: { ...H, Version: "2021-07-28" } });
    if (!cr.ok) return { ok: false, error: `contact HTTP ${cr.status}` };
    const tags = (((await cr.json()) as { contact?: { tags?: string[] } }).contact?.tags ?? []).map((t) => String(t).toLowerCase());
    /* The AI-hold cleanup cancelled her unpaid hold and she paid afterwards:
       that is the one "gone" appointment the booking step knows how to bring
       back (see /api/onebox/book, removedHolds). */
    if (tags.includes(REMOVED_TAG)) return { ok: true, state: "none", note: "the AI's unpaid hold was removed by the cleanup" };
    if (rows.some((r) => r.gone && Number.isFinite(r.addedMs) && r.addedMs >= since)) {
      return { ok: true, state: "needs_person", note: "an appointment made after she picked this time was cancelled" };
    }
    const act = await appointmentActivitySince(a.token, a.locationId, a.contactId, since);
    if (!act.ok) return { ok: false, error: act.error };
    if (act.touched) return { ok: true, state: "needs_person", note: "an appointment was made or changed after she picked this time, and none is on the calendar now" };
    return { ok: true, state: "none", note: "no appointment was ever made for her" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 140) : "lookup failed" };
  }
}

/* GHL writes every appointment change into the contact's conversation as an
   activity line ("New appointment created", "Appointment Cancelled", …) and
   keeps it even when the appointment itself is deleted. */
async function appointmentActivitySince(token: string, locationId: string, contactId: string, sinceMs: number): Promise<{ ok: true; touched: boolean } | { ok: false; error: string }> {
  const H = { Authorization: `Bearer ${token}`, Version: "2021-04-15", Accept: "application/json" };
  const sr = await fetch(`${GHL}/conversations/search?locationId=${encodeURIComponent(locationId)}&contactId=${encodeURIComponent(contactId)}`, { headers: H });
  if (!sr.ok) return { ok: false, error: `conversations HTTP ${sr.status}` };
  const convs = ((await sr.json()) as { conversations?: { id?: string }[] }).conversations ?? [];
  for (const cv of convs.slice(0, 3)) {
    if (!cv.id) continue;
    const mr = await fetch(`${GHL}/conversations/${encodeURIComponent(cv.id)}/messages?limit=100`, { headers: H });
    if (!mr.ok) return { ok: false, error: `messages HTTP ${mr.status}` };
    const msgs = ((await mr.json()) as { messages?: { messages?: { messageType?: string; dateAdded?: string }[] } }).messages?.messages ?? [];
    if (msgs.some((m) => String(m.messageType ?? "") === "TYPE_ACTIVITY_APPOINTMENT" && Date.parse(String(m.dateAdded ?? "")) >= sinceMs)) {
      return { ok: true, touched: true };
    }
  }
  return { ok: true, touched: false };
}
