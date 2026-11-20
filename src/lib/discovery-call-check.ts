import type { SupabaseClient } from "@supabase/supabase-js";
import { getAppLocationToken } from "@/lib/ghl-app";
import { fileAlert, ghlContactUrl } from "@/lib/alerts";
import { getReplyAccount, sendConversationMessage } from "@/lib/ghl-conversations";

// ── "Jennifer hasn't called the discovery lead yet" ─────────────────────────
// Replaces the GHL pair "Discovery - If didn't call within 7 minutes ->
// Internal SMS Nicolas" + "If outbound call to discovery stop internal to
// Nicolas". The 11/13/2026 audit found 16 of 19 of its alerts false:
//   • GHL's "Call details" trigger fires only when a call ENDS, so a call that
//     started on time and was still going at minute 7 never stopped it;
//   • the stop workflow has re-entry OFF, so a lead called before never
//     stopped it again;
//   • the warm-transfer call from "Discovery Call Flow" is a different record
//     type (TYPE_CAMPAIGN_CALL) that is easy to miss.
// Here we read the lead's call records straight from GHL. A live test
// (11/14/2026) showed a call record appears ~1 minute after the call starts,
// while it is still ringing / going, so checking at minute 8 sees every call
// that started by minute 7.

const LOC = "SfpNMJ5YU9lBkxss47lK"; // PMU Bookings On Demand (agency account)
// The same two calendars the GHL alert listens to (owner's scope — no others).
const CALENDARS: Record<string, string> = {
  sM5ENt37b5MGwKDOSOrl: "Discovery",
  FCh30J8vxsFdVKQsBEMH: "PPS Discovery",
};
const BASE = "https://services.leadconnectorhq.com";
const CHECK_AFTER_MIN = 8; // 7 min rule + ~1 min for GHL to show the call
const GIVE_UP_AFTER_MIN = 20; // never alert about an appointment older than this
const SETTINGS_KEY = "discovery_call_check";
const ALERT_TYPE = "discovery_no_call" as const;

type Svc = SupabaseClient;
// app_settings.discovery_call_check: { enabled, text, phone? }. Missing = on.
// phone = who gets the text; defaults to the owner's phone from the Agent
// panel settings (agent_notify) — but NOT its on/off switch, which is about
// the AI agent's texts, not this alert.
// We send by PHONE NUMBER, not a saved contact id (owner, 11/16/2026: "just
// send it to my number, because sometimes I change the contact on the
// system"). The first real alert (11/16) never reached him: the saved contact
// id did not exist in the agency account.
// pushWebhook = the inbound-webhook URL of the agency workflow "Discovery
// no-call push to Nicolas (dashboard webhook)". It sends a LeadConnector app
// notification that opens the lead's chat when tapped (owner, 11/20/2026: the
// web link in the text does not open the contact on his phone; tested OK).
export type CheckSettings = { enabled: boolean; text: boolean; phone: string | null; pushWebhook: string | null };

export async function getCheckSettings(svc: Svc): Promise<CheckSettings> {
  const { data } = await svc.from("app_settings").select("key, value").in("key", [SETTINGS_KEY, "agent_notify"]);
  const rows = (data ?? []) as { key: string; value: Record<string, unknown> | null }[];
  const v = (rows.find((r) => r.key === SETTINGS_KEY)?.value ?? {}) as { enabled?: boolean; text?: boolean; phone?: string; pushWebhook?: string };
  const owner = (rows.find((r) => r.key === "agent_notify")?.value ?? {}) as { phone?: string };
  return { enabled: v.enabled !== false, text: v.text !== false, phone: v.phone || owner.phone || null, pushWebhook: v.pushWebhook || null };
}

// The owner's contact in the agency account, found by phone at send time.
// If no contact has that phone any more, one is made (phone only).
async function ownerContactId(acct: { locationId: string; token: string }, phone: string): Promise<string | null> {
  const h = { Authorization: `Bearer ${acct.token}`, Version: "2021-07-28", Accept: "application/json", "Content-Type": "application/json" };
  const digits = phone.replace(/\D/g, "").slice(-10);
  const r = await fetch(`${BASE}/contacts/search/duplicate?locationId=${acct.locationId}&number=${encodeURIComponent(phone)}`, { headers: h, cache: "no-store" }).catch(() => null);
  const hit = r?.ok ? ((await r.json().catch(() => null)) as { contact?: { id?: string; phone?: string } | null } | null)?.contact : null;
  if (hit?.id && String(hit.phone ?? "").replace(/\D/g, "").endsWith(digits)) return hit.id;
  const u = await fetch(`${BASE}/contacts/upsert`, { method: "POST", headers: h, body: JSON.stringify({ locationId: acct.locationId, phone }) }).catch(() => null);
  return u?.ok ? (((await u.json().catch(() => null)) as { contact?: { id?: string } } | null)?.contact?.id ?? null) : null;
}

export async function textTheOwner(phone: string | null, message: string): Promise<string | null> {
  if (!phone) return "no owner phone set";
  const acct = await getReplyAccount();
  if (!acct) return "main account token unavailable";
  const contactId = await ownerContactId(acct, phone);
  if (!contactId) return `no contact for the owner's phone ${phone.slice(-4)}`;
  const r = await sendConversationMessage(acct, { contactId, message: message.slice(0, 900), channel: "SMS" });
  return r.ok ? null : `text failed: ${r.error}`;
}

// App notification to the owner through the GHL workflow (see CheckSettings).
export async function pushTheOwner(webhook: string | null, p: { contactId: string; title: string; message: string }): Promise<string | null> {
  if (!webhook) return null; // not set up — the text still goes out
  const r = await fetch(webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contact_id: p.contactId, title: p.title.slice(0, 120), message: p.message.slice(0, 500) }) }).catch(() => null);
  return r?.ok ? null : `push failed (${r ? r.status : "network"})`;
}

class GhlError extends Error {}

async function ghl<T>(tok: string, path: string, version = "2021-07-28"): Promise<T> {
  let last = "";
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(BASE + path, { headers: { Authorization: `Bearer ${tok}`, Version: version }, cache: "no-store" });
      if (r.ok) return (await r.json()) as T;
      last = `${r.status}`;
      if (r.status === 401 || r.status === 403 || r.status === 404) break;
    } catch (e) {
      last = e instanceof Error ? e.message : "fetch failed";
    }
    await new Promise((res) => setTimeout(res, 600 * (i + 1)));
  }
  throw new GhlError(`GHL ${path.split("?")[0]} failed (${last})`);
}

type CallMsg = {
  id: string;
  messageType: string;
  direction?: string;
  status?: string;
  dateAdded: string;
  dateUpdated?: string;
  meta?: { call?: { status?: string; duration?: number } };
  error?: string;
};

export type CallVerdict = { reached: boolean; firstAt: number | null; how: string };

// Did anyone ring this lead (or talk with them) between `sinceMs` and `untilMs`?
//   TYPE_CALL outbound      — a person dialed the lead: always counts.
//   TYPE_CALL inbound       — counts only if it was picked up (or still going).
//   TYPE_CAMPAIGN_CALL      — the warm transfer: GHL rings the team member first
//     and dials the lead only after a key press. "completed" / "voicemail" mean
//     the lead's phone rang. "no-answer" / "canceled" (no key) / "busy" mean the
//     lead was never dialed. A record still open after 75 s (ring timeout 60 s)
//     means the team member answered and the call is live.
export function judgeCalls(msgs: CallMsg[], sinceMs: number, untilMs: number, nowMs: number): CallVerdict {
  let firstAt: number | null = null;
  let how = "";
  for (const m of msgs) {
    if (m.messageType !== "TYPE_CALL" && m.messageType !== "TYPE_CAMPAIGN_CALL") continue;
    const t = Date.parse(m.dateAdded);
    if (!(t >= sinceMs && t <= untilMs)) continue;
    const st = (m.status ?? m.meta?.call?.status ?? "").toLowerCase();
    const dur = m.meta?.call?.duration ?? 0;
    let ok = false;
    let label = "";
    if (m.messageType === "TYPE_CALL") {
      if (m.direction === "outbound") { ok = true; label = "call"; }
      else if ((st === "completed" && dur > 0) || st === "in-progress") { ok = true; label = "call from the lead"; }
    } else {
      const open = !st || st === "pending" || st === "ringing" || st === "in-progress" || st === "initiated" || st === "queued";
      if (st === "completed" || st === "voicemail") { ok = true; label = "warm call"; }
      else if (open && nowMs - t > 75_000) { ok = true; label = "warm call"; }
    }
    if (ok && (firstAt === null || t < firstAt)) { firstAt = t; how = label; }
  }
  return { reached: firstAt !== null, firstAt, how };
}

// Every conversation of the lead and of any duplicate contact with the same
// phone (the agency account has a few twins). Throws on a GHL failure so the
// caller never mistakes "couldn't read" for "no call".
export async function leadCalls(tok: string, contactId: string): Promise<{ name: string; calls: CallMsg[] }> {
  const ids = new Set<string>([contactId]);
  const c = await ghl<{ contact?: { phone?: string; firstName?: string; contactName?: string } }>(tok, `/contacts/${contactId}`);
  const phone = c.contact?.phone;
  const name = (c.contact?.firstName || c.contact?.contactName || "the lead").trim();
  if (phone) {
    const dup = await ghl<{ contacts?: { id: string; phone?: string }[] }>(tok, `/contacts/?locationId=${LOC}&query=${encodeURIComponent(phone)}&limit=10`);
    for (const d of dup.contacts ?? []) if (d.phone === phone) ids.add(d.id);
  }
  const out: CallMsg[] = [];
  for (const id of ids) {
    const conv = await ghl<{ conversations?: { id: string }[] }>(tok, `/conversations/search?locationId=${LOC}&contactId=${id}`);
    for (const cv of conv.conversations ?? []) {
      const m = await ghl<{ messages?: { messages?: CallMsg[] } }>(tok, `/conversations/${cv.id}/messages?limit=50`);
      out.push(...(m.messages?.messages ?? []));
    }
  }
  return { name, calls: out };
}

type CalEvent = { id: string; calendarId: string; contactId: string; startTime: string; appointmentStatus?: string; assignedUserId?: string; title?: string };

const ptTime = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" });

// GHL hands back startTime as a local string with an offset ("2026-11-14T16:00:00-08:00").
const startMsOf = (e: CalEvent) => Date.parse(e.startTime);

export type CheckResult = { checked: number; alerted: string[]; okay: string[]; resolved: number; skipped: string[]; errors: string[] };

export async function runDiscoveryCallCheck(svc: Svc, opts: { now?: number; dry?: boolean } = {}): Promise<CheckResult> {
  const now = opts.now ?? Date.now();
  const res: CheckResult = { checked: 0, alerted: [], okay: [], resolved: 0, skipped: [], errors: [] };
  const settings = await getCheckSettings(svc);
  if (!settings.enabled && !opts.dry) { res.skipped.push("switched off"); return res; }
  const { token: tok, error } = await getAppLocationToken(LOC);
  if (!tok) { res.errors.push(`no GHL token: ${error ?? "unknown"}`); return res; }

  // Names for the text ("Jennifer hasn't called …").
  let users = new Map<string, string>();
  try {
    const u = await ghl<{ users?: { id: string; firstName?: string; name?: string }[] }>(tok, `/users/?locationId=${LOC}`);
    users = new Map((u.users ?? []).map((x) => [x.id, x.firstName || (x.name ?? "").split(" ")[0] || "The team"]));
  } catch { /* names are cosmetic */ }

  // 1) Appointments that are now 8–20 minutes past their start.
  const from = now - GIVE_UP_AFTER_MIN * 60_000, to = now - CHECK_AFTER_MIN * 60_000;
  for (const [calId, calName] of Object.entries(CALENDARS)) {
    let events: CalEvent[] = [];
    try {
      const r = await ghl<{ events?: CalEvent[] }>(tok, `/calendars/events?locationId=${LOC}&calendarId=${calId}&startTime=${from - 3600_000}&endTime=${now}`, "2021-04-15");
      events = r.events ?? [];
    } catch (e) { res.errors.push(e instanceof Error ? e.message : "calendar read failed"); continue; }
    for (const ev of events) {
      const start = startMsOf(ev);
      if (!(start >= from && start <= to)) continue;
      if ((ev.appointmentStatus ?? "").toLowerCase() !== "confirmed") continue; // same rule as the GHL alert
      res.checked++;
      const who = users.get(ev.assignedUserId ?? "") ?? "The team";
      let lead: { name: string; calls: CallMsg[] };
      try { lead = await leadCalls(tok, ev.contactId); }
      catch (e) { res.errors.push(`${ev.id}: ${e instanceof Error ? e.message : "read failed"}`); continue; } // try again next minute
      const v = judgeCalls(lead.calls, start - 30 * 60_000, now, now);
      const leadName = lead.name;
      const label = `${leadName} (${calName} ${ptTime(start)})`;
      if (v.reached) { res.okay.push(`${label}: ${v.how} at ${ptTime(v.firstAt!)}`); continue; }
      res.alerted.push(label);
      if (opts.dry) continue;
      const filed = await fileAlert(svc, {
        type: ALERT_TYPE,
        severity: "high",
        title: `${who} hasn't called ${leadName} yet — ${calName} call at ${ptTime(start)} PT`,
        detail: `Checked at ${ptTime(now)} PT: no call to the lead from 30 min before the start until now (normal calls and the warm call both checked). Closes by itself when a call shows up. Lead: ${ghlContactUrl(LOC, ev.contactId)}`,
        source_key: `${ev.id}@${ev.startTime}`,
        meta: { contactId: ev.contactId, calendarId: calId, eventId: ev.id, start: ev.startTime, assignedUserId: ev.assignedUserId ?? null },
      });
      if (filed) {
        const err = await pushTheOwner(settings.pushWebhook, {
          contactId: ev.contactId,
          title: `📞 ${who} hasn't called ${leadName} yet`,
          message: `${calName} call was at ${ptTime(start)} PT (now ${ptTime(now)}). Tap to open the chat.`,
        });
        if (err) res.errors.push(`push: ${err}`);
      }
      if (filed && settings.text) {
        const err = await textTheOwner(settings.phone, `📞 ${who} hasn't called ${leadName} yet. ${calName} call was at ${ptTime(start)} PT (now ${ptTime(now)}). Call ${who}.\n${ghlContactUrl(LOC, ev.contactId)}`);
        if (err) res.errors.push(`text: ${err}`);
      }
    }
  }

  // 2) Close open alerts once a call shows up (the Alerts tab stays honest).
  //    Only the last 3 hours — an alert still open after that is a real miss.
  if (!opts.dry) {
    const { data: open } = await svc.from("alerts").select("id, meta, created_at").eq("type", ALERT_TYPE).eq("status", "open").gte("created_at", new Date(now - 3 * 3600_000).toISOString());
    for (const a of (open ?? []) as { id: string; meta: { contactId?: string; start?: string } | null }[]) {
      if (!a.meta?.contactId || !a.meta.start) continue;
      try {
        const start = Date.parse(a.meta.start);
        const v = judgeCalls((await leadCalls(tok, a.meta.contactId)).calls, start - 30 * 60_000, now, now);
        if (!v.reached) continue;
        const late = Math.round((v.firstAt! - start) / 60_000);
        await svc.from("alerts").update({ status: "resolved", resolved_by: `system (${v.how} at ${ptTime(v.firstAt!)} PT, ${late} min after start)`, resolved_at: new Date().toISOString() }).eq("id", a.id);
        res.resolved++;
      } catch { /* try again next run */ }
    }
  }
  return res;
}
