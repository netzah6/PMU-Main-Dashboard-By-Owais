import { createServiceClient } from "@/lib/supabase/server";
import { chatAccount, niceName, type AppChatAccount } from "@/lib/client-app";
import { cancelAppointmentQuietly } from "@/lib/appointment-cancel";
import { liveAppointmentsOnCalendar, wallToIso } from "@/lib/onebox";

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
     at most MAX_PER_DAY changes a day from the app.

   Also here (owner, 11/12/2026): the week calendar of the Bookings tab — her
   appointments and her opening hours, read live from her calendars — and
   "Book appointment" from a chat. A booking made here is the same as one she
   makes in her GoHighLevel calendar: her account's own booking workflow runs
   on it (tags, pipeline card, its texts) exactly as it does today. */

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
const fmt = (tz: string) => ({
  dayKey: new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }),
  dayLabel: new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }),
  time: new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }),
});
function groupDays(tz: string, slots: number[], skip?: number): SlotDay[] {
  const f = fmt(tz);
  const days = new Map<string, SlotDay>();
  for (const ms of slots) {
    if (ms === skip) continue;
    const d = new Date(ms), key = f.dayKey.format(d);
    if (!days.has(key)) days.set(key, { day: key, label: f.dayLabel.format(d), slots: [] });
    days.get(key)!.slots.push({ at: d.toISOString(), label: f.time.format(d) });
  }
  return [...days.values()];
}
const whenLabel = (tz: string, ms: number) => { const f = fmt(tz); return `${f.dayLabel.format(new Date(ms))} · ${f.time.format(new Date(ms))}`; };

export async function bookingSlots(token: string, id: string): Promise<{ ok: true; days: SlotDay[]; now: string } | Fail> {
  const acct = await chatAccount(token);
  if (!acct) return fail("Not available");
  const live = await liveAppointment(acct, id);
  if (!live.ok) return live;
  const slots = await freeSlots(acct, live.a.calendarId);
  if (!slots) return fail("We couldn't read your calendar. Please try again.", 502);
  return { ok: true, days: groupDays(acct.tz, slots, live.a.startMs), now: whenLabel(acct.tz, live.a.startMs) };
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

// ── Her calendars ───────────────────────────────────────────────────────────
type Cal = { id: string; name: string; slotMin: number; open: Array<{ days: number[]; from: number; to: number }> };
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
type OH = { daysOfTheWeek?: number[]; hours?: Array<{ openHour?: number; openMinute?: number; closeHour?: number; closeMinute?: number }> };
const openOf = (openHours: unknown): Cal["open"] => arr<OH>(openHours).flatMap((o) => arr<NonNullable<OH["hours"]>[number]>(o?.hours).map((h) => ({
  days: arr<number>(o?.daysOfTheWeek).map(Number),
  from: (Number(h?.openHour) || 0) * 60 + (Number(h?.openMinute) || 0),
  to: (Number(h?.closeHour) || 0) * 60 + (Number(h?.closeMinute) || 0),
}))).filter((x) => x.to > x.from);
/* `withHours`: the list does not carry the opening hours reliably, so each
   calendar is read on its own for them (the week view needs them). */
async function calendarsOf(acct: AppChatAccount, withHours = false): Promise<Cal[] | null> {
  const r = await fetch(`${GHL}/calendars/?locationId=${encodeURIComponent(acct.locationId)}`, { headers: H(acct.token) }).catch(() => null);
  if (!r?.ok) return null;
  const j = (await r.json().catch(() => null)) as { calendars?: unknown } | null;
  const list = arr<Record<string, unknown>>(j?.calendars).filter((c) => c && c.id && c.isActive !== false).slice(0, 8);
  const full = withHours ? await Promise.all(list.map(async (c) => {
    const d = await fetch(`${GHL}/calendars/${encodeURIComponent(String(c.id))}`, { headers: H(acct.token) }).catch(() => null);
    return d?.ok ? (((await d.json().catch(() => null)) as { calendar?: Record<string, unknown> } | null)?.calendar ?? null) : null;
  })) : [];
  return list.map((c, i) => {
    const unit = String(c.slotDurationUnit ?? "mins").toLowerCase();
    const n = Number(c.slotDuration) || 30;
    return {
      id: String(c.id), name: String(c.name ?? "Calendar").trim() || "Calendar",
      slotMin: Math.min(480, Math.max(10, unit.startsWith("hour") ? n * 60 : n)),
      open: openOf(full[i]?.openHours ?? c.openHours),
    };
  });
}

// ── Bookings tab: the week, as a calendar ───────────────────────────────────
export type WeekEvent = {
  id: string; name: string; day: number; startMin: number; endMin: number;
  /** booked = confirmed; hold = a time held until the deposit is paid; done = she came in. */
  kind: "booked" | "hold" | "done";
  when: string; contactId: string | null;
  /** She may move or cancel it from the app (confirmed and still ahead). */
  canChange: boolean;
};
export type WeekView = {
  title: string; prev: string | null; next: string | null; isThisWeek: boolean;
  days: Array<{ key: string; name: string; num: string; today: boolean; open: Array<[number, number]> }>;
  events: WeekEvent[];
  /** The hours the grid shows (minutes from midnight). */
  fromMin: number; toMin: number;
  /** false = her calendar could not be read just now. */
  ok: boolean;
};
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (key: string, n: number) => { const d = new Date(`${key}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export async function loadWeek(token: string, w?: string): Promise<WeekView | null> {
  const acct = await chatAccount(token);
  if (!acct) return null;
  const tz = acct.tz, f = fmt(tz);
  const today = f.dayKey.format(new Date());
  // Any week from a month back to three months ahead.
  let start = w && DAY_RE.test(w) ? w : today;
  if (start < addDays(today, -35) || start > addDays(today, 91)) start = today;
  const keys = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const weekFrom = Date.parse(wallToIso(`${keys[0]}T00:00:00`, tz)), weekTo = Date.parse(wallToIso(`${addDays(start, 7)}T00:00:00`, tz));
  const cals = await calendarsOf(acct, true);
  const lists = await Promise.all((cals ?? []).map(async (c) => {
    const r = await fetch(`${GHL}/calendars/events?locationId=${encodeURIComponent(acct.locationId)}&calendarId=${encodeURIComponent(c.id)}&startTime=${weekFrom}&endTime=${weekTo}`, { headers: H(acct.token) }).catch(() => null);
    if (!r?.ok) return null;
    return (((await r.json().catch(() => null)) as { events?: Array<Record<string, unknown>> } | null)?.events ?? []);
  }));
  const ok = !!cals && lists.every((l) => l !== null);
  const raw = lists.flatMap((l) => l ?? []);
  const ids = [...new Set(raw.map((e) => String(e.contactId ?? "")).filter(Boolean))];
  const { data: people } = ids.length
    ? await createServiceClient().from("ghl_contacts").select("id, contact_name").eq("owner_key", acct.ownerKey).in("id", ids)
    : { data: [] };
  const nameOf = new Map(((people ?? []) as Array<{ id: string; contact_name: string | null }>).map((p) => [p.id, (p.contact_name ?? "").trim()]));
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
  const minOf = (ms: number) => { const [h, m] = hm.format(new Date(ms)).split(":").map(Number); return (h % 24) * 60 + m; };
  const seen = new Set<string>();
  const events: WeekEvent[] = [];
  for (const e of raw) {
    const id = String(e.id ?? ""), st = String(e.appointmentStatus ?? e.appoinmentStatus ?? "").toLowerCase();
    const s = toMs(e.startTime, tz), en = toMs(e.endTime, tz);
    if (!id || seen.has(id) || e.deleted === true || !Number.isFinite(s) || /cancel|no.?show/.test(st)) continue;
    const day = keys.indexOf(f.dayKey.format(new Date(s)));
    if (day < 0) continue;
    seen.add(id);
    const contactId = String(e.contactId ?? "") || null;
    const startMin = minOf(s), mins = Number.isFinite(en) && en > s ? Math.round((en - s) / 60_000) : 30;
    events.push({
      id, day, startMin, endMin: Math.min(24 * 60, startMin + mins),
      name: niceName((contactId && nameOf.get(contactId)) || String(e.title ?? "").trim() || "Appointment"),
      kind: st === "invalid" ? "hold" : st === "showed" ? "done" : "booked",
      when: whenLabel(tz, s), contactId: contactId && nameOf.has(contactId) ? contactId : null,
      canChange: (st === "confirmed" || st === "new") && s > Date.now(),
    });
  }
  events.sort((x, y) => x.day - y.day || x.startMin - y.startMin);
  const days = keys.map((key) => {
    const d = new Date(`${key}T12:00:00Z`), wd = d.getUTCDay();
    const open = (cals ?? []).flatMap((c) => c.open.filter((o) => o.days.includes(wd)).map((o): [number, number] => [o.from, o.to])).sort((x, y) => x[0] - y[0]);
    return { key, name: d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }), num: String(d.getUTCDate()), today: key === today, open };
  });
  const lows = [...days.flatMap((d) => d.open.map((o) => o[0])), ...events.map((e) => e.startMin)];
  const highs = [...days.flatMap((d) => d.open.map((o) => o[1])), ...events.map((e) => e.endMin)];
  const short = (key: string) => new Date(`${key}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return {
    ok, events, days,
    title: `${short(keys[0])} – ${short(keys[6])}`,
    isThisWeek: start === today,
    prev: addDays(start, -7) >= addDays(today, -35) ? addDays(start, -7) : null,
    next: addDays(start, 7) <= addDays(today, 91) ? addDays(start, 7) : null,
    fromMin: lows.length ? Math.floor(Math.min(...lows) / 60) * 60 : 9 * 60,
    toMin: highs.length ? Math.ceil(Math.max(...highs) / 60) * 60 : 18 * 60,
  };
}

// ── Chat: book an appointment for this lead ─────────────────────────────────
type Lead = { name: string };
async function ownLead(acct: AppChatAccount, contactId: string): Promise<Lead | null> {
  if (!ID_RE.test(contactId)) return null;
  const { data } = await createServiceClient().from("ghl_contacts").select("contact_name").eq("id", contactId).eq("owner_key", acct.ownerKey).maybeSingle();
  return data ? { name: ((data as { contact_name: string | null }).contact_name ?? "").trim() } : null;
}
/** The time she already has on this calendar (booked or on hold), if any. */
async function existingTime(acct: AppChatAccount, contactId: string, calendarId: string): Promise<{ ok: boolean; when: string | null }> {
  const r = await liveAppointmentsOnCalendar(contactId, calendarId, acct.locationId, acct.token);
  if (!r.ok) return { ok: false, when: null };
  const a = r.appts.filter((x) => x.startMs > Date.now()).sort((x, y) => x.startMs - y.startMs)[0];
  return { ok: true, when: a ? whenLabel(acct.tz, a.startMs) : null };
}

export type BookOptions = { calendars: Array<{ id: string; name: string }>; calendarId: string; days: SlotDay[]; already: string | null };
export async function bookOptions(token: string, contactId: string, calendarId?: string): Promise<({ ok: true } & BookOptions) | Fail> {
  const acct = await chatAccount(token);
  if (!acct || !(await ownLead(acct, contactId))) return fail("Not available");
  const cals = await calendarsOf(acct);
  if (!cals) return fail("We couldn't read your calendar. Please try again.", 502);
  if (!cals.length) return fail("You have no calendar to book on yet — please ask your coach.");
  let cal = cals.find((c) => c.id === calendarId);
  if (!cal) {
    // The calendar most of her appointments are on.
    const { data } = await createServiceClient().from("ghl_appointments").select("calendar_id").eq("owner_key", acct.ownerKey)
      .order("start_time", { ascending: false }).limit(200);
    const n = new Map<string, number>();
    for (const r of (data ?? []) as Array<{ calendar_id: string | null }>) if (r.calendar_id) n.set(r.calendar_id, (n.get(r.calendar_id) ?? 0) + 1);
    cal = [...cals].sort((x, y) => (n.get(y.id) ?? 0) - (n.get(x.id) ?? 0))[0];
  }
  const [slots, has] = await Promise.all([freeSlots(acct, cal.id), existingTime(acct, contactId, cal.id)]);
  if (!slots || !has.ok) return fail("We couldn't read your calendar. Please try again.", 502);
  return { ok: true, calendars: cals.map((c) => ({ id: c.id, name: c.name })), calendarId: cal.id, days: groupDays(acct.tz, slots), already: has.when };
}

export async function bookForLead(token: string, contactId: string, calendarId: string, startRaw: unknown): Promise<{ ok: true; when: string } | Fail> {
  const acct = await chatAccount(token);
  const lead = acct ? await ownLead(acct, contactId) : null;
  if (!acct || !lead) return fail("Not available");
  const svc = createServiceClient();
  const { count } = await svc.from("client_app_booking_log").select("id", { count: "exact", head: true })
    .eq("owner_key", acct.ownerKey).gte("created_at", new Date(Date.now() - 86_400_000).toISOString());
  if ((count ?? 0) >= MAX_PER_DAY) return fail("That's a lot of changes for one day — please ask your coach for help.", 429);
  const cal = (await calendarsOf(acct))?.find((c) => c.id === calendarId);
  if (!cal) return fail("Not available");
  const start = Date.parse(String(startRaw ?? ""));
  if (!Number.isFinite(start)) return fail("Pick a time first");
  const [slots, has] = await Promise.all([freeSlots(acct, cal.id), existingTime(acct, contactId, cal.id)]);
  if (!slots || !has.ok) return fail("We couldn't read your calendar. Please try again.", 502);
  // One appointment per lead: a second one means two confirmations and two reminders.
  if (has.when) return fail(`She already has a time: ${has.when}. Move it from Bookings instead.`, 409);
  if (!slots.includes(start)) return fail("That time was just taken. Please pick another one.", 409);
  const body = {
    calendarId: cal.id, locationId: acct.locationId, contactId, title: lead.name || "Appointment", appointmentStatus: "confirmed",
    startTime: new Date(start).toISOString(), endTime: new Date(start + cal.slotMin * 60_000).toISOString(),
  };
  const r = await fetch(`${GHL}/calendars/events/appointments`, { method: "POST", headers: H(acct.token), body: JSON.stringify(body) }).catch(() => null);
  const j = r ? ((await r.json().catch(() => null)) as { id?: string } | null) : null;
  const log = (ok: boolean, note: string | null) => svc.from("client_app_booking_log").insert({
    owner_key: acct.ownerKey, appt_id: j?.id ?? "-", contact_id: contactId, action: "book", ok, note, from_start: null, to_start: new Date(start).toISOString(),
  }).then(() => {}, () => {});
  if (!r?.ok || !j?.id) { await log(false, `book failed (HTTP ${r?.status ?? "?"})`); return fail("We couldn't book it. Please try again.", 502); }
  await log(true, null);
  return { ok: true, when: whenLabel(acct.tz, start) };
}
