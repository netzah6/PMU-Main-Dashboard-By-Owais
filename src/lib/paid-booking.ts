import { AI_HOLD_STATUS, locationTimezone, wallToIso } from "@/lib/onebox";
import { REMOVED_TAG } from "@/lib/ai-hold-cleanup";

const GHL = "https://services.leadconnectorhq.com";
const TIMEOUT_MS = 8_000; // per GHL read; a hung read is an error, never "nothing there"

/* Look before a server job books a PAID lead's picked time (11/17/2026).

   The two safety nets (paid-tag-heal every 10 min, ghl-retry every 30 min)
   act long after the lead left the page, so they must never undo what a
   person did in between. They book only the clean case: nobody has touched
   her calendar since she picked. Everything else is left alone or handed to
   a person through an Alerts card.

   - other_time    she has a live appointment at ANOTHER time or on another
                   calendar: leave everything alone (/api/onebox/book would
                   cancel it, or double-book next to a calendar it cannot
                   see). `madeBeforePick` says it is older than her pick, or
                   on another calendar — she may have paid for a different
                   time than the one she is booked for, so a person is told.
   - same_time     her only live appointment sits at her picked time, on the
                   funnel's calendar. `unconfirmedHold`: it is still the AI's
                   unpaid hold ("invalid").
   - needs_person  no usable appointment, and the case is not clean: one was
                   made or changed after she picked and is gone now
                   (cancelled, or deleted — a deleted appointment is invisible
                   to the appointments API, so the conversation's own
                   appointment activity is read too), or only an unconfirmed
                   hold at another time is left.
   - none          nothing was ever booked for her: book the picked time

   Fails closed: any unreadable piece is an error, never "no appointments"
   (a failed lookup that read as "nothing there" is how the double bookings
   of 10/19 happened). */
export type PaidBookingLook =
  | { ok: true; state: "none"; note: string }
  | { ok: true; state: "same_time"; note: string; unconfirmedHold: boolean }
  | { ok: true; state: "other_time"; note: string; madeBeforePick: boolean }
  | { ok: true; state: "needs_person"; note: string }
  | { ok: false; error: string };

type Ev = { id?: string; calendarId?: string; startTime?: string; dateAdded?: string; appointmentStatus?: string; appoinmentStatus?: string; deleted?: boolean };

export async function lookBeforePaidBooking(a: {
  locationId: string; token: string; contactId: string; slotIso: string;
  /** The funnel's calendar. Without it any calendar counts as "her time". */
  calendarId?: string | null;
  /** When she picked the time (onebox_leads.picked_time_at, else created_at). */
  pickedAt?: string | null;
}): Promise<PaidBookingLook> {
  try {
    const H = { Authorization: `Bearer ${a.token}`, Accept: "application/json" };
    const cid = encodeURIComponent(a.contactId);
    const [tz, ar] = await Promise.all([
      locationTimezone(a.locationId, a.token),
      fetch(`${GHL}/contacts/${cid}/appointments`, { headers: { ...H, Version: "2021-07-28" }, signal: AbortSignal.timeout(TIMEOUT_MS) }),
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
    const pickedMs = Date.parse(String(a.pickedAt ?? ""));
    const since = Number.isFinite(pickedMs) ? pickedMs - 5 * 60_000 : now - 21 * 86_400_000;
    const rows = events.filter((e) => e.id).map((e) => {
      const status = String(e.appointmentStatus ?? e.appoinmentStatus ?? "").toLowerCase(); // GHL ships both spellings
      return { startMs: ms(e.startTime), addedMs: ms(e.dateAdded), status, calendarId: String(e.calendarId ?? ""), gone: e.deleted === true || status === "cancelled" };
    });
    type Row = (typeof rows)[number];
    // "At her time" means the same minute on the funnel's own calendar: that is
    // the only appointment the booking step can see and reuse.
    const atHerTime = (r: Row) => Math.abs(r.startMs - slotMs) < 60_000 && (!a.calendarId || r.calendarId === a.calendarId);
    const ahead = rows.filter((r) => !r.gone && r.status !== "noshow" && r.status !== "showed" && Number.isFinite(r.startMs) && r.startMs > now);

    /* Anything live that is NOT her picked time comes first, even when an
       appointment also sits at her time: /api/onebox/book cancels other
       fresh appointments ("last booking wins"), by-hand ones included, and
       it cannot see another calendar at all. Hands off. */
    const elsewhere = ahead.filter((r) => !atHerTime(r));
    if (elsewhere.length) {
      /* Only the AI's unpaid holds ("invalid") elsewhere. The account's
         workflow confirms a hold seconds after the paid tag lands, even a
         week-old one (Martina Ybarra, 11/06: an 8-day-old hold was confirmed
         5 s after the tag). A net looks 10+ minutes after the tag, so a hold
         that is STILL unconfirmed was not picked up by the workflow: she
         paid and has nothing confirmed, and booking her pick next to the
         hold could leave her with two. A person decides. */
      if (elsewhere.every((r) => r.status === AI_HOLD_STATUS)) return { ok: true, state: "needs_person", note: "she paid, but her only appointment is an unconfirmed hold at another time" };
      const madeBeforePick = elsewhere.every((r) => (!!a.calendarId && r.calendarId !== a.calendarId) || !(Number.isFinite(r.addedMs) && r.addedMs >= since));
      return { ok: true, state: "other_time", madeBeforePick, note: madeBeforePick
        ? "she has an appointment at another time that is older than this pick, or on another calendar"
        : "an appointment at another time was made for her after she picked" };
    }
    const here = ahead.filter(atHerTime);
    if (here.length) return { ok: true, state: "same_time", unconfirmedHold: here.every((r) => r.status === AI_HOLD_STATUS), note: "an appointment already sits at her picked time" };

    // Nothing live. Was anything made for her after she picked?
    const cr = await fetch(`${GHL}/contacts/${cid}`, { headers: { ...H, Version: "2021-07-28" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!cr.ok) return { ok: false, error: `contact HTTP ${cr.status}` };
    const tags = (((await cr.json()) as { contact?: { tags?: string[] } }).contact?.tags ?? []).map((t) => String(t).toLowerCase());
    /* The AI-hold cleanup cancelled her unpaid hold AT THIS TIME and she paid
       afterwards: the one "gone" appointment the booking step brings back
       (see /api/onebox/book, removedHolds). The tag is never taken off a
       contact, so it only counts together with that cancelled hold. */
    if (tags.includes(REMOVED_TAG) && rows.some((r) => r.status === "cancelled" && atHerTime(r))) {
      return { ok: true, state: "none", note: "the AI's unpaid hold at her time was removed by the cleanup" };
    }
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
   keeps it even when the appointment itself is deleted. Messages come newest
   first, 100 a page: read back until the page reaches the moment she picked
   (a lead the AI keeps texting passes 100 messages in two days). If that
   moment is still not reached after 10 pages, the answer is "could not
   read", never "nothing happened". */
async function appointmentActivitySince(token: string, locationId: string, contactId: string, sinceMs: number): Promise<{ ok: true; touched: boolean } | { ok: false; error: string }> {
  const H = { Authorization: `Bearer ${token}`, Version: "2021-04-15", Accept: "application/json" };
  const sr = await fetch(`${GHL}/conversations/search?locationId=${encodeURIComponent(locationId)}&contactId=${encodeURIComponent(contactId)}`, { headers: H, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!sr.ok) return { ok: false, error: `conversations HTTP ${sr.status}` };
  const convs = ((await sr.json()) as { conversations?: { id?: string }[] }).conversations ?? [];
  for (const cv of convs.slice(0, 3)) {
    if (!cv.id) continue;
    let last = "";
    for (let page = 0; ; page++) {
      if (page >= 10) return { ok: false, error: "her message thread is too long to read back to when she picked" };
      const mr = await fetch(`${GHL}/conversations/${encodeURIComponent(cv.id)}/messages?limit=100${last ? `&lastMessageId=${encodeURIComponent(last)}` : ""}`, { headers: H, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!mr.ok) return { ok: false, error: `messages HTTP ${mr.status}` };
      const box = ((await mr.json()) as { messages?: { messages?: { messageType?: string; dateAdded?: string }[]; nextPage?: boolean; lastMessageId?: string } }).messages;
      const msgs = box?.messages ?? [];
      if (msgs.some((m) => String(m.messageType ?? "") === "TYPE_ACTIVITY_APPOINTMENT" && Date.parse(String(m.dateAdded ?? "")) >= sinceMs)) {
        return { ok: true, touched: true };
      }
      const oldest = Math.min(...msgs.map((m) => Date.parse(String(m.dateAdded ?? ""))).filter(Number.isFinite));
      if (!msgs.length || !box?.nextPage || !box.lastMessageId || oldest < sinceMs) break; // read back far enough
      last = box.lastMessageId;
    }
  }
  return { ok: true, touched: false };
}
