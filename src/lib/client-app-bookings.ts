import { createServiceClient } from "@/lib/supabase/server";
import { chatAccount, type AppChatAccount } from "@/lib/client-app";
import { cancelAppointmentQuietly } from "@/lib/appointment-cancel";
import { wallToIso } from "@/lib/onebox";

/* Client app · Bookings: move or cancel an appointment (owner, 11/12/2026:
   "they will be able to reschedule or cancel appointment in that tab").

   This CHANGES her real calendar, so every step is checked live:
   - the appointment is read from GoHighLevel with the token of HER account
     only, so it cannot be another client's;
   - it must be confirmed and still ahead — never a hold, never a past one;
   - a new time must be one her calendar offers right now (no double booking);
   - a cancel uses the same quiet cancel the team's tools use — a plain cancel
     is undone by the account's booking workflow (see appointment-cancel.ts);
   - every change is written to client_app_booking_log, and a client can make
     at most MAX_PER_DAY changes a day from the app. */

const GHL = "https://services.leadconnectorhq.com";
const V = "2021-04-15";
const ID_RE = /^[A-Za-z0-9]{10,40}$/;
const MAX_PER_DAY = 20;
const AHEAD_DAYS = 30;

type Live = { id: string; contactId: string; calendarId: string; startMs: number; endMs: number; status: string };
type Fail = { ok: false; error: string; status: number };
const fail = (error: string, status = 400): Fail => ({ ok: false, error, status });
const H = (token: string) => ({ Authorization: `Bearer ${token}`, Version: V, Accept: "application/json", "Content-Type": "application/json" });

const toMs = (v: unknown, tz: string) => {
  const s = String(v ?? "");
  if (!s) return NaN;
  return Date.parse(/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s) ? s : wallToIso(s, tz));
};

/** The appointment as her calendar has it right now, or why she can't change it. */
async function liveAppointment(acct: AppChatAccount, id: string): Promise<{ ok: true; a: Live } | Fail> {
  if (!ID_RE.test(id)) return fail("Not available");
  const r = await fetch(`${GHL}/calendars/events/appointments/${encodeURIComponent(id)}`, { headers: H(acct.token) }).catch(() => null);
  if (!r?.ok) return fail("We couldn't open this appointment. Please try again.", 502);
  const j = (await r.json().catch(() => null)) as Record<string, unknown> | null;
  const e = ((j?.appointment ?? j?.event ?? j) ?? {}) as Record<string, unknown>;
  if (String(e.locationId ?? "") !== acct.locationId || e.deleted === true) return fail("Not available");
  const a: Live = {
    id: String(e.id ?? ""), contactId: String(e.contactId ?? ""), calendarId: String(e.calendarId ?? ""),
    startMs: toMs(e.startTime, acct.tz), endMs: toMs(e.endTime, acct.tz),
    status: String(e.appointmentStatus ?? e.appoinmentStatus ?? "").toLowerCase(),
  };
  if (a.id !== id || !a.contactId || !a.calendarId || !Number.isFinite(a.startMs)) return fail("Not available");
  if (a.status !== "confirmed" && a.status !== "new") return fail("This appointment was already changed. Please open Bookings again.", 409);
  if (a.startMs <= Date.now()) return fail("This appointment already started.", 409);
  return { ok: true, a };
}

/** The start times her calendar offers from now on (ms, sorted). */
async function freeSlots(acct: AppChatAccount, calendarId: string): Promise<number[] | null> {
  const from = Date.now();
  const r = await fetch(`${GHL}/calendars/${encodeURIComponent(calendarId)}/free-slots?startDate=${from}&endDate=${from + AHEAD_DAYS * 86_400_000}&timezone=${encodeURIComponent(acct.tz)}`, { headers: H(acct.token) }).catch(() => null);
  if (!r?.ok) return null;
  const j = (await r.json().catch(() => null)) as Record<string, unknown> | null;
  const out = new Set<number>();
  for (const v of Object.values(j ?? {})) {
    for (const iso of ((v as { slots?: unknown[] } | null)?.slots ?? [])) {
      const ms = toMs(iso, acct.tz);
      if (Number.isFinite(ms) && ms > from + 30 * 60_000) out.add(ms);
    }
  }
  return [...out].sort((x, y) => x - y);
}

export type SlotDay = { day: string; label: string; slots: Array<{ at: string; label: string }> };
export async function bookingSlots(token: string, id: string): Promise<{ ok: true; days: SlotDay[]; now: string } | Fail> {
  const acct = await chatAccount(token);
  if (!acct) return fail("Not available");
  const live = await liveAppointment(acct, id);
  if (!live.ok) return live;
  const slots = await freeSlots(acct, live.a.calendarId);
  if (!slots) return fail("We couldn't read your calendar. Please try again.", 502);
  const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: acct.tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const dayLabel = new Intl.DateTimeFormat("en-US", { timeZone: acct.tz, weekday: "short", month: "short", day: "numeric" });
  const timeLabel = new Intl.DateTimeFormat("en-US", { timeZone: acct.tz, hour: "numeric", minute: "2-digit" });
  const days = new Map<string, SlotDay>();
  for (const ms of slots) {
    if (ms === live.a.startMs) continue; // the time she already has
    const d = new Date(ms), key = dayKey.format(d);
    if (!days.has(key)) days.set(key, { day: key, label: dayLabel.format(d), slots: [] });
    days.get(key)!.slots.push({ at: d.toISOString(), label: timeLabel.format(d) });
  }
  return { ok: true, days: [...days.values()], now: `${dayLabel.format(new Date(live.a.startMs))} · ${timeLabel.format(new Date(live.a.startMs))}` };
}

export type BookingChange = { action: "cancel" } | { action: "move"; start: unknown };
export async function changeBooking(token: string, id: string, c: BookingChange): Promise<{ ok: true; settled: boolean } | Fail> {
  const acct = await chatAccount(token);
  if (!acct) return fail("Not available");
  if (c.action !== "cancel" && c.action !== "move") return fail("Not available");
  const svc = createServiceClient();
  const { count } = await svc.from("client_app_booking_log").select("id", { count: "exact", head: true })
    .eq("owner_key", acct.ownerKey).gte("created_at", new Date(Date.now() - 86_400_000).toISOString());
  if ((count ?? 0) >= MAX_PER_DAY) return fail("That's a lot of changes for one day — please ask your coach for help.", 429);
  const live = await liveAppointment(acct, id);
  if (!live.ok) return live;
  const a = live.a;
  const log = (ok: boolean, toMsValue: number | null, note: string | null) => svc.from("client_app_booking_log").insert({
    owner_key: acct.ownerKey, appt_id: a.id, contact_id: a.contactId, action: c.action, ok, note,
    from_start: new Date(a.startMs).toISOString(), to_start: toMsValue != null ? new Date(toMsValue).toISOString() : null,
  }).then(() => {}, () => {});

  if (c.action === "cancel") {
    // settled = the booking workflow can't bring it back. false = cancelled, but the team should look.
    const settled = await cancelAppointmentQuietly(acct.token, acct.locationId, a.contactId, a.id);
    const now = await liveAppointmentStatus(acct, a.id);
    if (now !== "cancelled") { await log(false, null, `cancel did not hold (status ${now ?? "unknown"})`); return fail("We couldn't cancel it. Please try again.", 502); }
    await log(true, null, settled ? null : "cancelled, but the booking workflow may still act on it");
    await svc.from("ghl_appointments").update({ status: "cancelled" }).eq("id", a.id).then(() => {}, () => {});
    return { ok: true, settled };
  }

  const start = Date.parse(String(c.start ?? ""));
  if (!Number.isFinite(start) || start === a.startMs) return fail("Pick a new time first");
  const slots = await freeSlots(acct, a.calendarId);
  if (!slots) return fail("We couldn't read your calendar. Please try again.", 502);
  if (!slots.includes(start)) return fail("That time was just taken. Please pick another one.", 409);
  const minutes = Number.isFinite(a.endMs) && a.endMs > a.startMs ? a.endMs - a.startMs : 30 * 60_000;
  const startIso = new Date(start).toISOString(), endIso = new Date(start + minutes).toISOString();
  let moved = false;
  for (let attempt = 0; attempt < 3 && !moved; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, attempt === 1 ? 400 : 1200));
    moved = await fetch(`${GHL}/calendars/events/appointments/${encodeURIComponent(a.id)}`, {
      // The status is sent too: without it GoHighLevel puts a moved appointment back to "new" (seen on the 11/12 test).
      method: "PUT", headers: H(acct.token), body: JSON.stringify({ startTime: startIso, endTime: endIso, appointmentStatus: a.status }),
    }).then((r) => r.ok).catch(() => false);
  }
  if (!moved) { await log(false, start, "move failed"); return fail("We couldn't move it. Please try again.", 502); }
  await log(true, start, null);
  await svc.from("ghl_appointments").update({ start_time: startIso, end_time: endIso }).eq("id", a.id).then(() => {}, () => {});
  return { ok: true, settled: true };
}

async function liveAppointmentStatus(acct: AppChatAccount, id: string): Promise<string | null> {
  const r = await fetch(`${GHL}/calendars/events/appointments/${encodeURIComponent(id)}`, { headers: H(acct.token) }).catch(() => null);
  if (!r?.ok) return null;
  const j = (await r.json().catch(() => null)) as Record<string, unknown> | null;
  const e = ((j?.appointment ?? j?.event ?? j) ?? {}) as Record<string, unknown>;
  return String(e.appointmentStatus ?? e.appoinmentStatus ?? "").toLowerCase() || null;
}
