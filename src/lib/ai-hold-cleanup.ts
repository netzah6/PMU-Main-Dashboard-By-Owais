import type { SupabaseClient } from "@supabase/supabase-js";
import { getAppLocationToken } from "@/lib/ghl-app";
import { cancelAppointmentQuietly } from "@/lib/appointment-cancel";
import { AI_HOLD_STATUS } from "@/lib/onebox";

/* Remove the AI's unpaid holds (owner, 11/09/2026: "a lot of clients get
   confused… remove it after it's becoming invalid, so it will not confuse
   the permanent makeup artists about that empty slot").

   When CloseBot agrees a time in the chat it books it on the PMU calendar;
   10 minutes later the account's "Customer Booked Appointment" workflow
   turns it into an "invalid" appointment until the deposit lands. Checked
   live 11/09: the hold does NOT block the time (GHL offers the same slot to
   other leads), so it only shows the artist an appointment that isn't real.
   V2.3 accounts have no CloseBot and so never have one.

   Nothing is lost by removing it:
   - the time she agreed stays on her contact ("CC - Reserved Appointment
     Time", written by the same workflow), and the pay link reads that field
     when no appointment exists, so she still pays for that time;
   - paying on the pay link books a fresh, confirmed appointment (/book);
   - paying anywhere else: the paid-heal books the time of the hold removed
     here (tag REMOVED_TAG marks the contact; see paid-tag-heal).

   Only holds created through the API ("third_party" = CloseBot) are touched:
   an "invalid" one an artist made in the app or a lead made on an old GHL
   widget is left alone. Never a paid contact, never a hold under 15 minutes
   old (the workflow is still working on it), never a contact the AI booked
   again in the last 15 minutes (removing her from the confirm workflow
   would also drop that new booking's wait). Cancelling never texts her. */

const GHL = "https://services.leadconnectorhq.com";
const PAID_TAGS = ["fanbasis buyer", "deposit collected"];
export const REMOVED_TAG = "ai-hold-removed";
/* The confirm workflow waits 3 days for the paid tag, then sets THE
   APPOINTMENT IT STARTED WITH to confirmed — that would bring a cancelled
   hold back. So the contact leaves it too. */
const CONFIRM_WORKFLOW = /appointment status invalid/i;
const MIN_AGE_MS = 15 * 60_000;
const LOOK_AHEAD_MS = 180 * 86_400_000;

type Ev = { id?: string; contactId?: string; startTime?: string; dateAdded?: string; appointmentStatus?: string; appoinmentStatus?: string; deleted?: boolean; createdBy?: { source?: string }; title?: string };
export type HoldResult = { location: string; slug: string; contactId: string; appointmentId: string; start: string; title: string; done: boolean };

/* Which accounts: env AI_HOLD_CLEANUP = "all", or a comma list of GHL
   location ids (the Demo account for tests). Empty = off. */
export function holdCleanupScope(): "all" | string[] | null {
  const v = String(process.env.AI_HOLD_CLEANUP ?? "").trim();
  if (!v) return null;
  return v.toLowerCase() === "all" ? "all" : v.split(",").map((s) => s.trim()).filter(Boolean);
}

export async function removeAiHolds(
  svc: SupabaseClient, opts: { scope: "all" | string[]; dryRun?: boolean },
): Promise<{ accounts: number; removed: HoldResult[]; skipped: number; errors: string[] }> {
  const { data } = await svc.from("onebox_clients").select("slug, location_id, status, config, extras").neq("status", "draft");
  const clients = ((data ?? []) as Array<{ slug: string; location_id: string; config: Record<string, string> | null; extras: { template?: string } | null }>)
    .filter((c) => c.location_id && c.config?.calendarId && c.extras?.template !== "b2b")
    .filter((c) => opts.scope === "all" || opts.scope.includes(c.location_id));
  const removed: HoldResult[] = [], errors: string[] = [];
  let skipped = 0, accounts = 0;
  const now = Date.now();

  for (const c of clients) {
    try {
      const tok = await getAppLocationToken(c.location_id);
      if (!tok.token) { errors.push(`${c.slug}: ${tok.error ?? "no token"}`); continue; }
      const H = { Authorization: `Bearer ${tok.token}`, Accept: "application/json", "Content-Type": "application/json" };
      const r = await fetch(`${GHL}/calendars/events?locationId=${c.location_id}&calendarId=${c.config!.calendarId}&startTime=${now}&endTime=${now + LOOK_AHEAD_MS}`, { headers: { ...H, Version: "2021-04-15" } });
      if (!r.ok) { errors.push(`${c.slug}: events HTTP ${r.status}`); continue; }
      accounts++;
      const events = (((await r.json()) as { events?: Ev[] }).events ?? []).filter((e) => e.id && e.contactId && e.deleted !== true);
      const status = (e: Ev) => String(e.appointmentStatus ?? e.appoinmentStatus ?? "").toLowerCase();
      const holds = events.filter((e) => status(e) === AI_HOLD_STATUS && e.createdBy?.source === "third_party"
        && Date.parse(String(e.dateAdded)) <= now - MIN_AGE_MS && Date.parse(String(e.startTime)) > now);
      // The AI booked her again moments ago: wait for the next round.
      const busy = new Set(events.filter((e) => Date.parse(String(e.dateAdded)) > now - MIN_AGE_MS).map((e) => e.contactId!));
      const tagsOf = new Map<string, string[] | null>();
      for (const h of holds) {
        const cid = h.contactId!;
        if (busy.has(cid)) { skipped++; continue; }
        if (!tagsOf.has(cid)) {
          const cr = await fetch(`${GHL}/contacts/${encodeURIComponent(cid)}`, { headers: { ...H, Version: "2021-07-28" } });
          tagsOf.set(cid, cr.ok ? (((await cr.json()) as { contact?: { tags?: string[] } }).contact?.tags ?? []).map((t) => t.toLowerCase()) : null);
        }
        const tags = tagsOf.get(cid);
        // Unreadable contact or a paid one: never touch.
        if (!tags || tags.some((t) => PAID_TAGS.includes(t))) { skipped++; continue; }
        const row: HoldResult = { location: c.location_id, slug: c.slug, contactId: cid, appointmentId: h.id!, start: String(h.startTime), title: String(h.title ?? ""), done: false };
        if (opts.dryRun) { removed.push(row); continue; }
        // Tag first: if anything below stops half-way, the paid-heal still knows.
        await fetch(`${GHL}/contacts/${encodeURIComponent(cid)}/tags`, { method: "POST", headers: { ...H, Version: "2021-07-28" }, body: JSON.stringify({ tags: [REMOVED_TAG] }) }).catch(() => null);
        row.done = await cancelAppointmentQuietly(tok.token, c.location_id, cid, h.id!, { alsoLeave: [CONFIRM_WORKFLOW] });
        if (!row.done) errors.push(`${c.slug}: cancel ${h.id} not confirmed`);
        removed.push(row);
      }
    } catch (e) {
      errors.push(`${c.slug}: ${e instanceof Error ? e.message.slice(0, 100) : "error"}`);
    }
  }
  return { accounts, removed, skipped, errors };
}

/* For the paid-heal: she paid but has no live appointment, and we removed
   her AI hold. The time to book = that hold's start (the newest one we
   cancelled that is still ahead). Null = nothing of ours to restore. */
export async function removedHoldTime(token: string, contactId: string, calendarId: string): Promise<string | null> {
  const r = await fetch(`${GHL}/contacts/${encodeURIComponent(contactId)}/appointments`, {
    headers: { Authorization: `Bearer ${token}`, Version: "2021-07-28", Accept: "application/json" },
  }).catch(() => null);
  if (!r?.ok) return null;
  const events = (((await r.json()) as { events?: Array<Record<string, unknown>> }).events ?? []).filter((e) => e.deleted !== true && String(e.calendarId ?? "") === calendarId);
  const st = (e: Record<string, unknown>) => String(e.appointmentStatus ?? e.appoinmentStatus ?? "").toLowerCase();
  // Anything live on her calendar = she is booked; nothing to restore.
  if (events.some((e) => ["confirmed", "new", "invalid", "showed"].includes(st(e)))) return null;
  const cancelled = events.filter((e) => st(e) === "cancelled")
    .sort((a, b) => String(b.dateAdded ?? "").localeCompare(String(a.dateAdded ?? "")));
  /* This list has no "createdBy": read the newest cancelled one on its own
     and use it only if the AI (API, "third_party") made it — never a
     booking an artist made and cancelled. */
  const top = cancelled[0];
  if (!top?.id) return null;
  const one = await fetch(`${GHL}/calendars/events/appointments/${encodeURIComponent(String(top.id))}`, {
    headers: { Authorization: `Bearer ${token}`, Version: "2021-04-15", Accept: "application/json" },
  }).catch(() => null);
  const appt = one?.ok ? ((await one.json()) as { appointment?: { createdBy?: { source?: string } } }).appointment : null;
  if (appt?.createdBy?.source !== "third_party") return null;
  // Wall-clock "YYYY-MM-DD HH:mm:ss" on the contact list → /book reads it as the studio's time.
  const start = String(top.startTime ?? "").replace(" ", "T");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(start)) return null;
  // Read as UTC the wall clock is off by the studio's offset (up to ~10 h):
  // only a time safely ahead is booked; a person handles the rest.
  return Date.parse(start.slice(0, 19) + "Z") > Date.now() + 12 * 3600_000 ? start : null;
}
