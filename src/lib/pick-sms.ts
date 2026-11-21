import { createHash } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken } from "@/lib/ghl-app";
import { locationTimezone, wallToIso } from "@/lib/onebox";
import {
  SLOT_MARGIN_MS, confirmLink, eligibleFunnels, firstName, freshPickers, hasPaidTag, lastArea, leadPaidState, leadTimezone,
  newestRow, nextDaytime, paidByPick, paidOnCheckout, pickMoment, readContact, resolveSlot, serviceWords,
} from "@/lib/pick-email";

type Svc = ReturnType<typeof createServiceClient>;

/* "You picked a time" text for QUIET pickers (owner, 11/21/2026). A one-box
   lead who picks a time but never texts back gets no pay link by text today:
   the AI only talks once she texts. About an hour after the pick, half of
   those quiet, unpaid pickers get ONE text from the artist's sub-account with
   her own finish-booking link; the other half get nothing (only recorded), so
   the hold side shows what the text adds. One text per contact, ever.

   Who: exactly the deposit email's pickers (src/lib/pick-email.ts — same
   funnels, same paid / booked / slot checks, plus extras.noPickSms per
   funnel), and at the moment of sending: no inbound message from her on any
   channel since this visit began, no SMS do-not-disturb, a phone on file, the
   picked time 3+ hours ahead, daytime for her (9 AM–8 PM, else 9 AM).
   Both sides go through every check at the same moment — the hold side is
   "decided" exactly when the text side would be sent — so "quiet at 1 hour"
   means the same thing on both sides.

   Split: a salted hash of the phone, independent of the email's coin and of
   the deposit-ask test's last digit. Ships OFF (app_settings "pick_sms");
   switching it on starts counting picks from that moment. Runs inside the
   existing /api/cron/pick-email (after the email pass) — no cron of its own. */

export const PICK_SMS_KEY = "pick_sms";
const TABLE = "pick_sms_people";
const GHL = "https://services.leadconnectorhq.com";
const AFTER_MS = 60 * 60_000;             // about an hour after the pick
const ENROLL_LOOKBACK_MS = 24 * 3600_000; // older picks are never enrolled late
const MAX_AGE_MS = 24 * 3600_000;         // never "you picked a time" a day later
const QUIET_LOOKBACK_MS = 24 * 3600_000;  // "since this visit began" never reaches further back than this
const SMS_DAY = { from: 9, to: 20, resume: 9 }; // the lead's clock
const MAX_ATTEMPTS = 3;
const MAX_PER_RUN = 40;                   // decisions per run, both sides together

/* THE TEXT — draft, the owner approves it before the switch goes on.
   {first} = her clean first name ("there" when junk/empty → "Hi there!");
   {day}/{time} = the time she picked, as the booking page showed it;
   {service} = the area she asked for ("appointment" when unknown); {link} = her confirm link. */
export const PICK_SMS_TEXT =
  "Hi {first}! You picked {day} at {time} for your {service} 💕 It's still open. Finish your booking here to lock it in: {link}";

export type PickSmsSettings = { enabled: boolean; startAt: string | null; updatedBy?: string | null };
const DEFAULTS: PickSmsSettings = { enabled: false, startAt: null };

const isMissingTable = (e: { code?: string; message?: string } | null | undefined) =>
  !!e && (e.code === "PGRST205" || e.code === "42P01" || /could not find the table|does not exist/i.test(String(e.message ?? "")));

export async function getPickSmsSettings(svc: Svc): Promise<PickSmsSettings> {
  const { data } = await svc.from("app_settings").select("value").eq("key", PICK_SMS_KEY).maybeSingle();
  return { ...DEFAULTS, ...((data?.value as Partial<PickSmsSettings> | null) ?? {}) };
}

/** On → counting starts now (picks before this moment never get the text). Refuses while the table is missing. */
export async function setPickSmsEnabled(svc: Svc, enabled: boolean, by: string): Promise<PickSmsSettings> {
  const prev = await getPickSmsSettings(svc);
  const next: PickSmsSettings = { ...prev, enabled, updatedBy: by };
  if (enabled && !prev.enabled) {
    const probe = await svc.from(TABLE).select("contact_id").limit(1);
    if (isMissingTable(probe.error)) throw new Error("The pick_sms_people table isn't created yet (supabase/pick-sms.sql) — nothing can be recorded, so it stays off.");
    if (probe.error) throw new Error(probe.error.message);
    next.startAt = new Date().toISOString();
    // Back on after a pause: whoever was still waiting from the earlier period is closed, never texted days late.
    const { error: pe } = await svc.from(TABLE).update({ status: "paused", due_at: null, updated_at: next.startAt })
      .eq("status", "pending").lt("picked_at", next.startAt);
    if (pe) throw new Error(pe.message);
  }
  const { error } = await svc.from("app_settings").upsert({ key: PICK_SMS_KEY, value: next, updated_by: by, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
  return next;
}

// ─── The text ───────────────────────────────────────────────────────────────
/** "Sat, Nov 28" + "1:00 PM" from the studio wall-clock ISO the funnel stores — the same clock the booking page showed her. */
export function smsWhen(slotIso: string | null | undefined): { day: string; time: string } | null {
  const m = String(slotIso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  // ICU puts a narrow no-break space before "PM" — not a texting character; a plain space keeps the text in GSM where it can.
  const plain = (s: string) => s.replace(/[  ]/g, " ");
  return {
    day: plain(d.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" })),
    time: plain(d.toLocaleTimeString("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit" })),
  };
}

/* The funnel stores the slot with the calendar's own offset and the page shows
   that wall clock as is. A slot read back from slot_at (timestamptz) comes in
   UTC — only then is it moved onto the studio's clock, so the text names the
   hour she saw. */
export function studioClock(iso: string, tz: string): string {
  if (!/(Z|[+-]00:?00)$/.test(iso) || !tz) return iso;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms));
    const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
    return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
  } catch {
    return iso;
  }
}

export type SmsVars = { first: string; slotIso: string | null; service: string; link: string };
/** The text filled in for one lead. No readable time → "You picked a time". */
export function pickSmsText(v: SmsVars, template = PICK_SMS_TEXT): string {
  const w = smsWhen(v.slotIso);
  const t = w ? template : template.replace("{day} at {time}", "a time");
  return t
    .replace("{first}", v.first || "there")
    .replace("{day}", w?.day ?? "")
    .replace("{time}", w?.time ?? "")
    .replace("{service}", v.service || "appointment")
    .replace("{link}", v.link);
}

/* Carriers bill per segment: 160 plain characters (153 each when split), but
   any emoji or curly quote turns the whole text into Unicode — 70 (67 each). */
const GSM_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = "^{}\\[~]|€";
export function smsSegments(text: string): { chars: number; unicode: boolean; segments: number } {
  const chars = [...text];
  const unicode = chars.some((ch) => !GSM_BASIC.includes(ch) && !GSM_EXT.includes(ch));
  if (unicode) {
    const n = text.length; // UTF-16 units = what UCS-2 counts (an emoji is 2)
    return { chars: n, unicode, segments: n <= 70 ? 1 : Math.ceil(n / 67) };
  }
  const n = chars.reduce((s, ch) => s + (GSM_EXT.includes(ch) ? 2 : 1), 0);
  return { chars: n, unicode, segments: n <= 160 ? 1 : Math.ceil(n / 153) };
}

/** Same side for every row and re-pick of one person; unrelated to the email's coin and the last-digit split. */
export function pickSmsArm(phone: string): "sms" | "hold" {
  const last10 = String(phone ?? "").replace(/\D/g, "").slice(-10);
  return createHash("sha256").update(`pick-sms-v1:${last10}`).digest()[0] & 1 ? "sms" : "hold";
}

/** POST one SMS from the sub-account. GHL answers with the new message's id. */
async function postSms(tok: string, contactId: string, message: string): Promise<{ ok: boolean; status: number; messageId: string | null; error: string | null }> {
  const r = await fetch(`${GHL}/conversations/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, Version: "2021-04-15", "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ type: "SMS", contactId, message }),
  });
  if (r.ok) {
    const j = (await r.json().catch(() => ({}))) as { messageId?: string; id?: string };
    return { ok: true, status: r.status, messageId: String(j.messageId ?? j.id ?? "") || null, error: null };
  }
  return { ok: false, status: r.status, messageId: null, error: `HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 180)}` };
}

/* Did she send ANYTHING since `sinceMs` — a text, Facebook / Instagram /
   WhatsApp message, email, call, on any of her conversations? GHL's own
   activity lines (appointment created, form submitted…) don't count.
   Messages come newest first, 100 a page: read back until the page passes
   `sinceMs`; a thread too long to reach it is "can't tell", never "quiet". */
async function inboundSince(tok: string, locationId: string, contactId: string, sinceMs: number): Promise<{ ok: true; inbound: string | null } | { ok: false; why: string }> {
  const H = { Authorization: `Bearer ${tok}`, Version: "2021-04-15", Accept: "application/json" };
  const sr = await fetch(`${GHL}/conversations/search?locationId=${encodeURIComponent(locationId)}&contactId=${encodeURIComponent(contactId)}`, { headers: H });
  if (!sr.ok) return { ok: false, why: `conversations HTTP ${sr.status}` };
  const convs = ((await sr.json()) as { conversations?: { id?: string }[] }).conversations ?? [];
  for (const cv of convs.slice(0, 5)) {
    if (!cv.id) continue;
    let last = "";
    for (let page = 0; ; page++) {
      if (page >= 5) return { ok: false, why: "her message thread is too long to read back to the pick" };
      const mr = await fetch(`${GHL}/conversations/${encodeURIComponent(cv.id)}/messages?limit=100${last ? `&lastMessageId=${encodeURIComponent(last)}` : ""}`, { headers: H });
      if (!mr.ok) return { ok: false, why: `messages HTTP ${mr.status}` };
      const box = ((await mr.json()) as { messages?: { messages?: { direction?: string; messageType?: string; dateAdded?: string }[]; nextPage?: boolean; lastMessageId?: string } }).messages;
      const msgs = box?.messages ?? [];
      const hit = msgs.find((m) => String(m.direction ?? "").toLowerCase() === "inbound"
        && !/ACTIVITY/i.test(String(m.messageType ?? "")) && Date.parse(String(m.dateAdded ?? "")) >= sinceMs);
      if (hit) return { ok: true, inbound: String(hit.messageType ?? "unknown") };
      const oldest = Math.min(...msgs.map((m) => Date.parse(String(m.dateAdded ?? ""))).filter(Number.isFinite));
      if (!msgs.length || !box?.nextPage || !box.lastMessageId || oldest < sinceMs) break; // read back far enough
      last = box.lastMessageId;
    }
  }
  return { ok: true, inbound: null };
}

// ─── The run ────────────────────────────────────────────────────────────────
type Arm = "sms" | "hold";
type SmsPerson = {
  contact_id: string; location_id: string; slug: string; lead_id: number | null; phone: string | null; arm: Arm;
  picked_at: string; slot_at: string | null; status: string; due_at: string | null; attempts: number; decided_at: string | null;
};
const PERSON_COLS = "contact_id, location_id, slug, lead_id, phone, arm, picked_at, slot_at, status, due_at, attempts, decided_at";
const asTs = (iso: string | null | undefined) => (iso && Number.isFinite(Date.parse(iso)) ? iso : null);

export type PickSmsPreview = { contactId: string; slug: string; arm: Arm; dueAt: string; text: string };
export type PickSmsRun = {
  enabled: boolean; dryRun: boolean; tableMissing?: boolean;
  enrolled: { sms: number; hold: number };
  sent: number; held: number; deferred: number;
  skipped: { sms: Record<string, number>; hold: Record<string, number> };
  errors: string[]; partial: boolean;
  // Dry run only:
  notDueYet?: number;
  unchecked?: number;               // due, but past this run's limit / time budget
  wouldSend?: PickSmsPreview[];     // the text side: who WOULD get the text now (or at dueAt, her morning)
  wouldHold?: number;               // the hold side: passed every check, would be recorded, gets nothing
  skippedList?: { contactId: string; slug: string; arm: Arm; reason: string }[];
  repliedBy?: Record<string, number>; // what she sent that made her not quiet (message type)
  tzDiffers?: number;               // her contact's timezone ≠ the studio's (the text names the studio's clock, as the page did)
};

/* Enrol new pickers (both sides) as "pending", due an hour after the pick;
   then decide what's due: every check, for both sides, at the same moment —
   text side → send, hold side → "held". dryRun: nothing is written or sent —
   returns what WOULD happen (sinceIso stands in for the switch-on moment). */
export async function runPickSms(svc: Svc, opts: { dryRun?: boolean; sinceIso?: string; now?: Date; budgetMs?: number; limit?: number } = {}): Promise<PickSmsRun> {
  const started = Date.now();
  const budget = opts.budgetMs ?? 90_000;
  const limit = opts.limit ?? MAX_PER_RUN;
  const now = opts.now ?? new Date();
  const dryRun = !!opts.dryRun;
  const settings = await getPickSmsSettings(svc);
  const res: PickSmsRun = {
    enabled: settings.enabled, dryRun, enrolled: { sms: 0, hold: 0 }, sent: 0, held: 0, deferred: 0,
    skipped: { sms: {}, hold: {} }, errors: [], partial: false,
  };
  // Nothing may send while off: no switch-on moment → nothing to do (a dry run brings its own).
  const startAt = dryRun ? (opts.sinceIso ?? settings.startAt) : settings.enabled ? settings.startAt : null;
  if (!startAt) return res;
  const funnels = await eligibleFunnels(svc, ["noPickEmail", "noPickSms"]);

  // 1. Enrol: contacts who picked a time since the switch-on (and in the last day).
  const since = new Date(Math.max(Date.parse(startAt), now.getTime() - ENROLL_LOOKBACK_MS)).toISOString();
  const byContact = await freshPickers(svc, since, funnels);
  const ids = [...byContact.keys()];
  const known = new Set<string>();
  for (let i = 0; i < ids.length; i += 300) {
    const { data, error } = await svc.from(TABLE).select("contact_id").in("contact_id", ids.slice(i, i + 300));
    if (isMissingTable(error) && dryRun) { res.tableMissing = true; break; } // not created yet: nobody is known
    if (error) throw new Error(error.message);
    for (const r of data ?? []) known.add(r.contact_id as string);
  }
  const queue: SmsPerson[] = [];
  for (const [contactId, rows] of byContact) {
    if (known.has(contactId)) continue;
    const latest = newestRow(rows);
    const pickedAt = pickMoment(rows, startAt);
    const arm = pickSmsArm(latest.phone ?? "");
    const person: SmsPerson = {
      contact_id: contactId, location_id: latest.location_id, slug: latest.slug, lead_id: latest.id ?? null, phone: latest.phone, arm,
      picked_at: pickedAt.toISOString(), slot_at: asTs(latest.slot_iso), status: "pending", attempts: 0, decided_at: null,
      due_at: new Date(pickedAt.getTime() + AFTER_MS).toISOString(),
    };
    res.enrolled[arm]++;
    if (dryRun) { queue.push(person); continue; }
    const { error } = await svc.from(TABLE).insert(person);
    if (error && !/duplicate key/i.test(error.message)) res.errors.push(`enrol ${contactId}: ${error.message}`);
  }

  // 2. Decide what's due — both sides (picks from an earlier switched-on period never resume).
  let due: SmsPerson[] = queue.filter((p) => Date.parse(p.due_at as string) <= now.getTime());
  if (dryRun) {
    res.notDueYet = queue.length - due.length;
    res.wouldSend = []; res.wouldHold = 0; res.skippedList = []; res.repliedBy = {}; res.tzDiffers = 0;
  } else {
    const { data, error } = await svc.from(TABLE).select(PERSON_COLS)
      .eq("status", "pending").lte("due_at", now.toISOString()).gte("picked_at", startAt)
      .order("due_at").limit(limit);
    if (error) throw new Error(error.message);
    due = (data ?? []) as SmsPerson[];
  }

  const toks = new Map<string, string | null>();
  const tokenFor = async (loc: string) => {
    if (!toks.has(loc)) toks.set(loc, (await getAppLocationToken(loc)).token ?? null);
    return toks.get(loc) ?? null;
  };
  const stamp = () => new Date().toISOString();
  // A check said no: final for this contact (decided_at, if already set by a send retry, stays — the readout keeps her on her side).
  const skip = async (p: SmsPerson, reason: string) => {
    res.skipped[p.arm][reason] = (res.skipped[p.arm][reason] ?? 0) + 1;
    if (dryRun) { res.skippedList!.push({ contactId: p.contact_id, slug: p.slug, arm: p.arm, reason }); return; }
    await svc.from(TABLE).update({ status: reason, due_at: null, updated_at: stamp() }).eq("contact_id", p.contact_id).eq("status", "pending");
  };
  /* Couldn't decide this run (GHL or the database unreachable): try again in
     30 minutes, give up after 3 tries — a stuck row never blocks the queue. */
  const later = async (p: SmsPerson, why: string) => {
    res.errors.push(`${p.slug}: ${why}`);
    if (dryRun) { res.skipped[p.arm].cant_check = (res.skipped[p.arm].cant_check ?? 0) + 1; return; }
    const attempts = p.attempts + 1;
    await svc.from(TABLE).update({
      attempts, error: why.slice(0, 300), updated_at: stamp(),
      due_at: attempts >= MAX_ATTEMPTS ? null : new Date(now.getTime() + 30 * 60_000).toISOString(),
      status: attempts >= MAX_ATTEMPTS ? "check_failed" : "pending",
    }).eq("contact_id", p.contact_id).eq("status", "pending");
  };

  const batch = due.slice(0, limit);
  if (dryRun) res.unchecked = due.length - batch.length;
  for (const p of batch) {
    if (Date.now() - started > budget) { res.partial = true; if (dryRun) res.unchecked! += batch.length - batch.indexOf(p); break; }
    try {
      // The client may have been paused / switched to free booking / opted out since the pick.
      const funnel = funnels.get(p.slug);
      if (!funnel) { await skip(p, "funnel_off"); continue; }
      if (now.getTime() - Date.parse(p.picked_at) > MAX_AGE_MS) { await skip(p, "too_late"); continue; }

      const ps = await leadPaidState(svc, p.slug, p.contact_id, p.phone, p.picked_at);
      if (ps.kind === "error") { await later(p, ps.why); continue; }
      if (ps.kind === "no_lead_row") { await skip(p, "no_lead_row"); continue; }
      if (ps.kind !== "open") { await skip(p, ps.kind); continue; }
      const rows = ps.rows;

      const tok = await tokenFor(p.location_id);
      if (!tok) { await later(p, "no GHL token for the sub-account"); continue; }
      const cr = await readContact(tok, p.contact_id);
      if (cr.kind === "gone") { await skip(p, "contact_gone"); continue; }
      if (cr.kind === "error") { await later(p, cr.why); continue; }
      const c = cr.c;
      if (hasPaidTag(c)) { await skip(p, "paid"); continue; }
      if (!String(c.phone ?? "").trim()) { await skip(p, "no_phone"); continue; }
      // dndSettings.SMS only — the contact-level `dnd` flag is unreliable (owner, 11/21/2026).
      const smsDnd = String(((c.dndSettings ?? {}) as Record<string, { status?: string } | undefined>).SMS?.status ?? "").toLowerCase();
      if (smsDnd === "active" || smsDnd === "permanent") { await skip(p, "sms_dnd"); continue; }

      const cfg = funnel.config ?? {};
      const co = await paidOnCheckout(svc, String(c.email ?? "").trim(), String(cfg.fanbasisProductId ?? "").trim(), p.picked_at);
      if (!co.ok) { await later(p, co.why); continue; }
      if (co.paid) { await skip(p, "paid"); continue; }

      const sr0 = await resolveSlot({ contactId: p.contact_id, locationId: p.location_id, tok, cfg, rows, contact: c, fallbackSlot: p.slot_at, now });
      if (sr0.kind === "error") { await later(p, sr0.why); continue; }
      if (sr0.kind === "booked") { await skip(p, "booked"); continue; }
      const { slotIso, locTz } = sr0;
      // No time ahead, or it's less than 3 hours away → nothing left to finish.
      if (!slotIso || Date.parse(slotIso) - now.getTime() < SLOT_MARGIN_MS) { await skip(p, "slot_passed"); continue; }

      // Night for her → both sides wait for her 9 AM, and every check runs again then.
      const tz = leadTimezone(c, locTz);
      if (dryRun && locTz && tz !== locTz) res.tzDiffers!++;
      const sendAt = nextDaytime(now, tz, SMS_DAY);
      if (sendAt.getTime() > now.getTime() + 60_000 && !dryRun) {
        res.deferred++;
        await svc.from(TABLE).update({ due_at: sendAt.toISOString(), updated_at: stamp() }).eq("contact_id", p.contact_id).eq("status", "pending");
        continue;
      }

      /* Quiet = nothing from her since this visit began: the pick, or her
         newest survey of this visit if that came first (a re-pick stamps the
         same pick time on every row, so the pick alone can move later than a
         text she sent in between) — never more than a day before the pick. */
      const pickMs = Date.parse(p.picked_at);
      const newestSurvey = Math.max(...rows.map((r) => Date.parse(r.created_at)).filter(Number.isFinite));
      const visitStart = Math.max(Math.min(pickMs, Number.isFinite(newestSurvey) ? newestSurvey : pickMs), pickMs - QUIET_LOOKBACK_MS);
      const q = await inboundSince(tok, p.location_id, p.contact_id, visitStart);
      if (!q.ok) { await later(p, q.why); continue; }
      if (q.inbound) {
        if (dryRun) res.repliedBy![q.inbound] = (res.repliedBy![q.inbound] ?? 0) + 1;
        await skip(p, "replied");
        continue;
      }

      const text = pickSmsText({
        first: firstName(String(c.firstName ?? ""), newestRow(rows).full_name),
        slotIso: studioClock(slotIso, locTz), service: serviceWords(lastArea(rows)), link: confirmLink(p.slug, p.contact_id, "sms"),
      });
      if (dryRun) {
        if (p.arm === "sms") res.wouldSend!.push({ contactId: p.contact_id, slug: p.slug, arm: p.arm, dueAt: sendAt.toISOString(), text });
        else res.wouldHold!++;
        continue;
      }

      const decidedAt = p.decided_at ?? now.toISOString();
      if (p.arm === "hold") {
        // Passed every check at the moment the text would go: recorded, nothing sent.
        const { data: held } = await svc.from(TABLE).update({ status: "held", decided_at: decidedAt, slot_at: asTs(slotIso), updated_at: stamp() })
          .eq("contact_id", p.contact_id).eq("status", "pending").select("contact_id");
        if (held?.length) res.held++;
        continue;
      }

      // Claim before sending — a crash can lose one text, never send it twice.
      const { data: claimed } = await svc.from(TABLE)
        .update({ status: "sent", decided_at: decidedAt, sent_at: now.toISOString(), slot_at: asTs(slotIso), updated_at: stamp() })
        .eq("contact_id", p.contact_id).eq("status", "pending").select("contact_id");
      if (!claimed?.length) continue;
      /* NOT VERIFIED YET (check before switch-on): CloseBot's "Bot Auto Shutoff"
         adds "ai off" when it sees an outbound text it didn't write, and the
         AI never answers a reply that came in while "ai off" was on. If the
         Demo test (test hook below) shows "ai off" after this text, the owner's
         recipe — ~2 min later remove "ai off", add "ai on" + "(v3)", V3 funnels
         only, only if "ai off" wasn't there before — must be added here first. */
      const sent = await postSms(tok, p.contact_id, text);
      if (sent.ok) {
        res.sent++;
        await svc.from(TABLE).update({ message_id: sent.messageId, attempts: 0, error: null, updated_at: stamp() }).eq("contact_id", p.contact_id);
        continue;
      }
      const err = sent.error ?? `HTTP ${sent.status}`;
      res.errors.push(`${p.slug}: ${err}`);
      /* A 5xx may have gone out anyway (GHL's gateway can time out after
         queueing it) — keep the claim: one possibly-missed text beats a
         double. Only a clear refusal hands it back for a retry. */
      if (sent.status >= 500) {
        await svc.from(TABLE).update({ error: err, updated_at: stamp() }).eq("contact_id", p.contact_id);
        continue;
      }
      const attempts = p.attempts + 1;
      const optOut = /\bdnd\b|do not disturb|opt(ed)?[\s-]?out|unsubscrib/i.test(err);
      await svc.from(TABLE).update({
        sent_at: null, attempts, error: err, updated_at: stamp(),
        due_at: optOut || attempts >= MAX_ATTEMPTS ? null : new Date(now.getTime() + 30 * 60_000).toISOString(),
        status: optOut ? "sms_dnd" : attempts >= MAX_ATTEMPTS ? "send_failed" : "pending",
      }).eq("contact_id", p.contact_id);
    } catch (e) {
      await later(p, e instanceof Error ? e.message : String(e)).catch(() => {});
    }
  }
  return res;
}

// ─── Test hook (one text to one named contact — never the table) ────────────
/* For the owner's own test phone (Demo account): the real text, with a fake
   pick 2 days out at 1 PM studio time, to exactly the contact named — works
   while the switch is off, never reads or writes pick_sms_people, never
   texts anyone else. The cron route gates it behind CRON_SECRET + ?testContact=.
   aiTags = her AI tags as read just before the send; calling it again with
   ?dry=1 a couple of minutes later (no text) reads them again — the
   "does CloseBot switch the AI off after our text?" check before switch-on. */
const AI_TAGS = ["ai on", "ai off", "(v3)"];
export async function sendPickSmsTest(svc: Svc, o: { contactId: string; locationId: string; slug?: string | null; area?: string | null; dryRun?: boolean }): Promise<{ ok: boolean; sent: boolean; text?: string; aiTags?: string[]; messageId?: string | null; error?: string }> {
  if (!/^[A-Za-z0-9]{8,40}$/.test(o.contactId) || !/^[A-Za-z0-9]{8,40}$/.test(o.locationId)) return { ok: false, sent: false, error: "testContact and testLocation must be GHL ids" };
  let q = svc.from("onebox_clients").select("slug, location_id, status").eq("location_id", o.locationId);
  if (o.slug) q = q.eq("slug", o.slug.toLowerCase());
  const { data: fs, error: fe } = await q.limit(20);
  if (fe) return { ok: false, sent: false, error: fe.message };
  const f = ((fs ?? []) as { slug: string; status: string | null }[]).sort((a, b) => Number(b.status === "live") - Number(a.status === "live"))[0];
  if (!f) return { ok: false, sent: false, error: "no funnel for that location (and slug)" };
  const tok = (await getAppLocationToken(o.locationId)).token;
  if (!tok) return { ok: false, sent: false, error: "no GHL token for the sub-account" };
  const cr = await readContact(tok, o.contactId);
  if (cr.kind !== "ok") return { ok: false, sent: false, error: cr.kind === "gone" ? "contact not found in that location" : cr.why };
  const c = cr.c;
  if (c.locationId && String(c.locationId) !== o.locationId) return { ok: false, sent: false, error: "that contact belongs to another location" };
  const aiTags = ((c.tags as string[] | undefined) ?? []).map((t) => String(t).toLowerCase()).filter((t) => AI_TAGS.includes(t));
  if (!String(c.phone ?? "").trim()) return { ok: false, sent: false, error: "the contact has no phone" };
  const smsDnd = String(((c.dndSettings ?? {}) as Record<string, { status?: string } | undefined>).SMS?.status ?? "").toLowerCase();
  if (smsDnd === "active" || smsDnd === "permanent") return { ok: false, sent: false, error: "the contact has SMS do-not-disturb on" };
  const locTz = await locationTimezone(o.locationId, tok);
  const day = new Date(Date.now() + 2 * 86400_000).toLocaleDateString("en-CA", { timeZone: locTz || "America/New_York" }); // YYYY-MM-DD
  const wall = `${day}T13:00:00`;
  const text = pickSmsText({
    first: firstName(String(c.firstName ?? ""), String(c.contactName ?? c.name ?? "")),
    slotIso: locTz ? wallToIso(wall, locTz) : wall,
    service: serviceWords(o.area ?? "Eyebrows"),
    link: confirmLink(f.slug, o.contactId, "sms"),
  });
  if (o.dryRun) return { ok: true, sent: false, text, aiTags };
  const s = await postSms(tok, o.contactId, text);
  return s.ok ? { ok: true, sent: true, text, aiTags, messageId: s.messageId } : { ok: false, sent: false, text, aiTags, error: s.error ?? `HTTP ${s.status}` };
}

// ─── Readout (Funnels card) ─────────────────────────────────────────────────
/* The comparison is only between people who passed every check at the
   moment of the text: "decided" (text side: texted, or the send failed; hold
   side: recorded). Paid = the email readout's rule (one of her funnel rows
   paid within 7 days of the pick, never an earlier visit's deposit), among
   people not paid before that moment (always 1 h+ after the pick). */
export const READ_MIN_PER_SIDE = 1500, READ_MIN_PAID = 100;
const MATURE_MS = 7 * 86400_000;
export type PickSmsSide = {
  enrolled: number; pending: number; decided: number; sent: number; skipped: Record<string, number>;
  open: number; paid: number; matured: { open: number; paid: number }; earlier: number; clicked: number; paidAfterClick: number;
  paidPct: number | null; // null until the readout gate is met
};
export type PickSmsSummary = {
  settings: PickSmsSettings; tableMissing: boolean;
  sides: { sms: PickSmsSide; hold: PickSmsSide };
  gate: { minPerSide: number; minPaid: number; ready: boolean };
  firstMatureOn: string | null; errors: number; lastError: string | null;
};

export async function pickSmsSummary(svc: Svc): Promise<PickSmsSummary> {
  const settings = await getPickSmsSettings(svc);
  type Row = SmsPerson & { sent_at: string | null; clicked_at: string | null; error: string | null; updated_at: string };
  const people: Row[] = [];
  let tableMissing = false;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await svc.from(TABLE).select(`${PERSON_COLS}, sent_at, clicked_at, error, updated_at`).order("contact_id").range(from, from + 999);
    if (isMissingTable(error)) { tableMissing = true; break; }
    if (error) throw new Error(error.message);
    people.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) break;
  }
  const decided = people.filter((p) => p.decided_at);
  const { paidAt, paidBefore } = await paidByPick(svc, decided);
  const nowMs = Date.now();
  const side = (arm: Arm): Omit<PickSmsSide, "paidPct"> => {
    const ps = people.filter((p) => p.arm === arm);
    const skipped: Record<string, number> = {};
    let open = 0, paid = 0, mOpen = 0, mPaid = 0, earlier = 0, clicked = 0, paidAfterClick = 0;
    for (const p of ps) {
      if (!p.decided_at) {
        if (p.status !== "pending") skipped[p.status] = (skipped[p.status] ?? 0) + 1;
        continue;
      }
      const pick = Date.parse(p.picked_at), decidedMs = Date.parse(p.decided_at);
      const at = paidAt.get(p.contact_id); // undefined = not paid for this pick
      if (at === undefined && paidBefore.has(p.contact_id)) { earlier++; continue; }
      if (at != null && at <= decidedMs) continue; // paid before the text (the check missed it): out of both sides
      open++;
      const won = at === null || (at !== undefined && at <= pick + MATURE_MS);
      if (won) paid++;
      if (nowMs - pick >= MATURE_MS) { mOpen++; if (won) mPaid++; }
      if (p.clicked_at) {
        clicked++;
        if (won && at != null && at >= Date.parse(p.clicked_at)) paidAfterClick++;
      }
    }
    return {
      enrolled: ps.length, pending: ps.filter((p) => p.status === "pending").length, decided: ps.filter((p) => p.decided_at).length,
      sent: ps.filter((p) => p.status === "sent").length, skipped,
      open, paid, matured: { open: mOpen, paid: mPaid }, earlier, clicked, paidAfterClick,
    };
  };
  const s = side("sms"), h = side("hold");
  const ready = s.matured.open >= READ_MIN_PER_SIDE && h.matured.open >= READ_MIN_PER_SIDE && s.matured.paid + h.matured.paid >= READ_MIN_PAID;
  // The %s exist only once the gate is met — the card can't show a result too early.
  const pct = (x: typeof s) => (ready && x.matured.open ? Math.round((x.matured.paid / x.matured.open) * 1000) / 10 : null);
  const errs = people.filter((p) => p.error).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return {
    settings, tableMissing,
    sides: { sms: { ...s, paidPct: pct(s) }, hold: { ...h, paidPct: pct(h) } },
    gate: { minPerSide: READ_MIN_PER_SIDE, minPaid: READ_MIN_PAID, ready },
    firstMatureOn: settings.startAt ? new Date(Date.parse(settings.startAt) + MATURE_MS).toISOString() : null,
    errors: errs.length, lastError: errs[0]?.error ?? null,
  };
}
