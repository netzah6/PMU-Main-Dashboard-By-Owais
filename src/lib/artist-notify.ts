import { getAppLocationToken } from "@/lib/ghl-app";
import { fmtReservedTime } from "@/lib/onebox";

/* The artist's "new appointment" text, replacing the GHL internal
   notification that one-box bookings can never trigger: the template
   workflow ("Appointment Status Invalid -> Confirm if Fanbasis tag in 3
   days") only fires on UNCONFIRMED appointments, and the one-box books
   every paid appointment as confirmed — so since the cutover no artist
   heard about new bookings (found 2026-09-26 via Glam Brows By Sara /
   The Brow and Ink Atelier / browology+ / INKredible Body Art).

   The recipient is the sub-account's own STAFF user (never a sheet),
   and the SMS goes out FROM THE CLIENT'S OWN SUB-ACCOUNT — the same
   number their lead and appointment notifications already come from
   (owner rule, 2026-09-26; the first draft used the agency number). */

type GhlUser = { deleted?: boolean; name?: string; phone?: string; roles?: { type?: string; role?: string } };

/* The sub-account user who should hear about bookings: an account-type
   member (agency staff are filtered out so they never get a client's
   notification), not deleted, with a real phone; the account admin wins
   over other members. */
export async function findArtistUser(locationId: string): Promise<{ name: string; phone: string } | null> {
  const tok = await getAppLocationToken(locationId);
  if (!tok.token) return null;
  const r = await fetch(`https://services.leadconnectorhq.com/users/?locationId=${locationId}`, {
    headers: { Authorization: `Bearer ${tok.token}`, Version: "2021-07-28", Accept: "application/json" },
  }).catch(() => null);
  if (!r || !r.ok) return null;
  const users = (((await r.json()) as { users?: GhlUser[] }).users ?? [])
    .filter((u) => !u.deleted && String(u.roles?.type ?? "") === "account" && String(u.phone ?? "").replace(/\D/g, "").length >= 10);
  const pick = users.find((u) => String(u.roles?.role ?? "") === "admin") ?? users[0];
  return pick ? { name: String(pick.name ?? ""), phone: String(pick.phone) } : null;
}

export function bookingMessage(area: string, leadName: string, slotIso: string): string {
  const what = area.trim() ? `${area.trim()} appointment` : "appointment";
  return `New ${what} secured! 🎉\n\n${leadName} at ${fmtReservedTime(slotIso)}.\n\nPlease call to confirm!`;
}

/* Fire-and-forget from the booking paths: never throws, never blocks the
   lead's confirmation. Returns a note for logs. */
export async function notifyArtistOfBooking(inp: {
  locationId: string; leadName: string; area: string; slotIso: string;
}): Promise<{ ok: boolean; note: string }> {
  try {
    const artist = await findArtistUser(inp.locationId);
    if (!artist) return { ok: false, note: "no account user with a phone on the sub-account" };
    /* Send from the client's OWN sub-account so the artist sees the same
       number their other internal notifications come from. The artist is
       upserted as a contact in their own account (no tags — nothing for
       the survey workflows to trigger on). */
    const tok = await getAppLocationToken(inp.locationId);
    if (!tok.token) return { ok: false, note: `location token: ${tok.error ?? "missing"}` };
    const up = await fetch("https://services.leadconnectorhq.com/contacts/upsert", {
      method: "POST",
      headers: { Authorization: `Bearer ${tok.token}`, Version: "2021-07-28", "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ locationId: inp.locationId, name: artist.name, phone: artist.phone }),
    });
    const contactId = ((await up.json().catch(() => ({}))) as { contact?: { id?: string } }).contact?.id;
    if (!contactId) return { ok: false, note: `artist contact upsert failed (${up.status})` };
    /* conversations/messages wants Version 2021-04-15 — 2021-07-28 is the
       classic silent failure on this endpoint. */
    const sr = await fetch("https://services.leadconnectorhq.com/conversations/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${tok.token}`, Version: "2021-04-15", "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ type: "SMS", contactId, message: bookingMessage(inp.area, inp.leadName, inp.slotIso) }),
    });
    if (!sr.ok) return { ok: false, note: `SMS send ${sr.status}: ${(await sr.text().catch(() => "")).slice(0, 120)}` };
    return { ok: true, note: `notified ${artist.name || artist.phone}` };
  } catch (e) {
    return { ok: false, note: String(e).slice(0, 160) };
  }
}
