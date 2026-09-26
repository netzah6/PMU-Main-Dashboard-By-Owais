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

type GhlUser = { id?: string; deleted?: boolean; name?: string; phone?: string; roles?: { type?: string; role?: string } };

/* The sub-account user who should hear about bookings: an account-type
   member (agency staff are filtered out so they never get a client's
   notification), not deleted, with a real phone; the account admin wins
   over other members. */
export async function findArtistUser(locationId: string): Promise<{ id: string; name: string; phone: string } | null> {
  const tok = await getAppLocationToken(locationId);
  if (!tok.token) return null;
  const r = await fetch(`https://services.leadconnectorhq.com/users/?locationId=${locationId}`, {
    headers: { Authorization: `Bearer ${tok.token}`, Version: "2021-07-28", Accept: "application/json" },
  }).catch(() => null);
  if (!r || !r.ok) return null;
  const users = (((await r.json()) as { users?: GhlUser[] }).users ?? [])
    .filter((u) => !u.deleted && String(u.roles?.type ?? "") === "account" && String(u.phone ?? "").replace(/\D/g, "").length >= 10);
  const pick = users.find((u) => String(u.roles?.role ?? "") === "admin") ?? users[0];
  return pick ? { id: String(pick.id ?? ""), name: String(pick.name ?? ""), phone: String(pick.phone) } : null;
}

/* The notify workflow's recipient is "Contact owner", so a contact nobody
   owns makes the workflow fire into silence — 10 of the 36 backfilled
   bookings (7 accounts) hit exactly that on 2026-09-26. Called right
   before the onebox-booked tag lands: give an ownerless contact the
   account's artist (same pick as findArtistUser). Never reassigns an
   existing owner — lead distribution stays whatever the account set up. */
export async function ensureContactOwner(locationId: string, contactId: string): Promise<{ ok: boolean; note: string }> {
  try {
    const tok = await getAppLocationToken(locationId);
    if (!tok.token) return { ok: false, note: tok.error ?? "no location token" };
    const H = { Authorization: `Bearer ${tok.token}`, Version: "2021-07-28", Accept: "application/json", "Content-Type": "application/json" };
    const cr = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, { headers: H });
    if (!cr.ok) return { ok: false, note: `contact ${cr.status}` };
    if (((await cr.json()) as { contact?: { assignedTo?: string } }).contact?.assignedTo) return { ok: true, note: "already owned" };
    const artist = await findArtistUser(locationId);
    if (!artist?.id) return { ok: false, note: "no account user with a phone to assign" };
    const pu = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      method: "PUT", headers: H, body: JSON.stringify({ assignedTo: artist.id }),
    });
    return pu.ok ? { ok: true, note: `assigned ${artist.name}` } : { ok: false, note: `assign ${pu.status}` };
  } catch (e) {
    return { ok: false, note: String(e).slice(0, 120) };
  }
}

export function bookingMessage(area: string, leadName: string, slotIso: string): string {
  const what = area.trim() ? `${area.trim()} appointment` : "appointment";
  return `New ${what} secured! 🎉\n\n${leadName} at ${fmtReservedTime(slotIso)}.\n\nPlease call to confirm!`;
}

/* The production notification path (owner design 2026-09-26, 100% inside
   GHL): the dashboard adds this tag right after a paid booking (and after
   the reserved-time field is written), and the account's "CC - One-Box
   Booking -> Notify Artist" workflow sends the internal notification from
   the sub-account's own number, then removes the tag so a future
   re-booking fires again. Manual GHL bookings never get the tag, so they
   never text the artist. Additive tag endpoint only — an upsert body
   would wipe the contact's tag list. */
export async function addOneboxBookedTag(locationId: string, contactId: string): Promise<{ ok: boolean; note: string }> {
  try {
    const tok = await getAppLocationToken(locationId);
    if (!tok.token) return { ok: false, note: tok.error ?? "no location token" };
    const r = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok.token}`, Version: "2021-07-28", "Content-Type": "application/json" },
      body: JSON.stringify({ tags: ["onebox-booked"] }),
    });
    return r.ok ? { ok: true, note: "tag added" } : { ok: false, note: `tags ${r.status}` };
  } catch (e) {
    return { ok: false, note: String(e).slice(0, 120) };
  }
}

/* Did the account's OWN workflow already notify the artist about this
   lead? Most sub-accounts carry a "Fanbasis tag added" workflow that
   sends the same "appointment secured" text ~1-2 min after the Commas
   webhook tags the payer — but only when the appointment already exists
   at tag time, which is a race the dashboard booking wins about half
   the time (measured 2026-09-26: 17 notified vs 34 missed over 14 days).
   So the cron sends OURS only when the artist's thread has no "secured"
   message naming the lead. Name matching is punctuation-insensitive
   (Ja'Mise's curly apostrophe produced a false miss). */
const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export async function artistAlreadyNotified(locationId: string, leadName: string): Promise<{ known: boolean; notified: boolean }> {
  try {
    const tok = await getAppLocationToken(locationId);
    if (!tok.token) return { known: false, notified: false };
    const H4 = { Authorization: `Bearer ${tok.token}`, Version: "2021-04-15", Accept: "application/json" };
    const H7 = { ...H4, Version: "2021-07-28" };
    const artist = await findArtistUser(locationId);
    if (!artist) return { known: false, notified: false };
    const p10 = String(artist.phone).replace(/\D/g, "").slice(-10);
    const cr = await fetch(`https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&query=${p10}&limit=5`, { headers: H7 }).catch(() => null);
    const contacts = cr && cr.ok ? (((await cr.json()) as { contacts?: { id: string; phone?: string }[] }).contacts ?? []) : [];
    const contact = contacts.find((c) => String(c.phone ?? "").replace(/\D/g, "").slice(-10) === p10) ?? contacts[0];
    // No artist contact = the account has never received these texts — nothing to double.
    if (!contact) return { known: true, notified: false };
    const vr = await fetch(`https://services.leadconnectorhq.com/conversations/search?locationId=${locationId}&contactId=${contact.id}`, { headers: H4 }).catch(() => null);
    const conv = vr && vr.ok ? ((((await vr.json()) as { conversations?: { id: string }[] }).conversations ?? [])[0]) : null;
    if (!conv) return { known: true, notified: false };
    const mr = await fetch(`https://services.leadconnectorhq.com/conversations/${conv.id}/messages?limit=100`, { headers: H7 }).catch(() => null);
    if (!mr || !mr.ok) return { known: false, notified: false };
    const msgs = (((await mr.json()) as { messages?: { messages?: { body?: string }[] } }).messages?.messages ?? []);
    const secured = norm(msgs.map((m) => String(m.body ?? "")).filter((b) => /secured/i.test(b)).join(" | "));
    const name = norm(leadName);
    const tokens = name.split(" ").filter((t) => t.length > 1);
    const hit = !!name && (secured.includes(name) || (tokens.length >= 2 && tokens.every((t) => secured.includes(t))));
    return { known: true, notified: hit };
  } catch {
    return { known: false, notified: false };
  }
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
