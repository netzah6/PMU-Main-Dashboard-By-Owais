import { getAppLocationToken } from "@/lib/ghl-app";
import { wallToIso } from "@/lib/onebox";
import { areaWords } from "@/lib/ai-back-on";

/* "Add to my calendar" link for the booking text (owner, 11/28/2026).

   The text carries https://book.pmu-care.com/cal/{{location.id}}/{{contact.id}}.
   We read that client's next confirmed appointment live from HER studio's
   GoHighLevel account and give her a calendar entry that says what and where:
   "Eyebrows at J. Nicole Brows", the studio address, no cancel/move links.

   Why not GoHighLevel's own {{appointment.add_to_google_calendar}}: its entry
   is titled with the client's own name (the calendar's event-title setting,
   which also names the booking in the ARTIST's calendar, so we can't change
   it), has no address, and carries self-serve Cancel and Reschedule links
   that skip the artist (checked on the Demo test, 11/28/2026).

   Read only. Nothing here changes the appointment or the contact. */

const GHL = "https://services.leadconnectorhq.com";
const ID_RE = /^[A-Za-z0-9]{8,40}$/;
const AREA_FIELD_KEY = "contact.which_areas_would_you_like_treated";

export type CalEntry = {
  title: string;        // "Eyebrows at J. Nicole Brows"
  studio: string;       // "J. Nicole Brows"
  address: string;      // "1405-F Kiln Creek Parkway, Newport News VA 23602"
  startMs: number;
  endMs: number;
  tz: string;
  appointmentId: string;
};

const H = (token: string, v = "2021-07-28") => ({ Authorization: `Bearer ${token}`, Version: v, Accept: "application/json" });

async function getJson(url: string, token: string, v?: string): Promise<Record<string, unknown> | null> {
  const r = await fetch(url, { headers: H(token, v), cache: "no-store" }).catch(() => null);
  if (!r?.ok) return null;
  return (await r.json().catch(() => null)) as Record<string, unknown> | null;
}

/** Studio name as a client should read it: no hidden marks, no trailing dot. */
export function cleanStudioName(v: unknown): string {
  return String(v ?? "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "")
    .trim();
}

const toMs = (v: unknown, tz: string) => {
  const s = String(v ?? "");
  if (!s) return NaN;
  return Date.parse(/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s) ? s : wallToIso(s, tz));
};

/** The client's next confirmed appointment in this studio, ready for a calendar. */
export async function loadCalendarEntry(locationId: string, contactId: string): Promise<CalEntry | null> {
  if (!ID_RE.test(locationId) || !ID_RE.test(contactId)) return null;
  const { token } = await getAppLocationToken(locationId);
  if (!token) return null;

  const [locJ, contactJ, apptJ, fieldsJ] = await Promise.all([
    getJson(`${GHL}/locations/${locationId}`, token),
    getJson(`${GHL}/contacts/${contactId}`, token),
    getJson(`${GHL}/contacts/${contactId}/appointments`, token),
    getJson(`${GHL}/locations/${locationId}/customFields`, token),
  ]);
  const loc = (locJ?.location ?? null) as Record<string, unknown> | null;
  const contact = (contactJ?.contact ?? null) as Record<string, unknown> | null;
  // The contact must belong to this studio, so a link can never show another studio's data.
  if (!loc || !contact || String(contact.locationId ?? "") !== locationId) return null;

  const tz = String(loc.timezone ?? "") || "America/New_York";
  const now = Date.now();
  const events = ((apptJ?.events ?? []) as Record<string, unknown>[])
    .filter((e) => e && e.deleted !== true)
    .filter((e) => String(e.appointmentStatus ?? e.appoinmentStatus ?? "").toLowerCase() === "confirmed")
    .map((e) => ({ id: String(e.id ?? ""), startMs: toMs(e.startTime, tz), endMs: toMs(e.endTime, tz) }))
    .filter((e) => e.id && Number.isFinite(e.startMs) && e.startMs > now - 3 * 3600_000)
    .sort((a, b) => a.startMs - b.startMs);
  const next = events[0];
  if (!next) return null;

  const fieldId = ((fieldsJ?.customFields ?? []) as { id: string; fieldKey?: string }[]).find((f) => f.fieldKey === AREA_FIELD_KEY)?.id;
  const rawArea = fieldId ? ((contact.customFields ?? []) as { id: string; value?: unknown }[]).find((f) => f.id === fieldId)?.value : undefined;
  const area = areaWords(rawArea);

  const studio = cleanStudioName(loc.name) || "your appointment";
  const cityLine = [loc.city, loc.state].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ");
  const tail = [cityLine, String(loc.postalCode ?? "").trim()].filter(Boolean).join(" ");
  const street = String(loc.address ?? "").trim();
  const city = String(loc.city ?? "").trim().toLowerCase();
  // Some studios typed city/state/zip into the street line too; don't print them twice.
  const address = street && city && street.toLowerCase().includes(city)
    ? street.replace(/[,\s]+$/, "")
    : [street, tail].filter(Boolean).join(", ");

  return {
    title: `${area || "Permanent makeup"} at ${studio}`,
    studio,
    address,
    startMs: next.startMs,
    endMs: Number.isFinite(next.endMs) && next.endMs > next.startMs ? next.endMs : next.startMs + 60 * 60_000,
    tz,
    appointmentId: next.id,
  };
}

const icsDate = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");

export const CAL_NOTE = "Need to change the time? Just text me and I'll help.";

/** An .ics file (Apple Calendar, Outlook): one event, a reminder 2 hours before. */
export function icsFor(e: CalEntry): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//PMU Bookings On Demand//Appointment//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${e.appointmentId}@book.pmu-care.com`,
    `DTSTAMP:${icsDate(Date.now())}`,
    `DTSTART:${icsDate(e.startMs)}`,
    `DTEND:${icsDate(e.endMs)}`,
    `SUMMARY:${icsText(e.title)}`,
    `LOCATION:${icsText(e.address)}`,
    `DESCRIPTION:${icsText(CAL_NOTE)}`,
    "BEGIN:VALARM",
    "TRIGGER:-PT2H",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsText(e.title)}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n") + "\r\n";
}

/** Google Calendar "add event" page with everything filled in. */
export function googleUrlFor(e: CalEntry): string {
  const q = new URLSearchParams({
    action: "TEMPLATE",
    text: e.title,
    dates: `${icsDate(e.startMs)}/${icsDate(e.endMs)}`,
    location: e.address,
    details: CAL_NOTE,
    ctz: e.tz,
  });
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}

/** "Saturday, December 5, 2026 at 2:00 PM" in the studio's time zone. */
export function whenText(e: CalEntry): string {
  const d = new Date(e.startMs);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: e.tz, weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: e.tz, hour: "numeric", minute: "2-digit" }).format(d);
  return `${day} at ${time}`;
}
