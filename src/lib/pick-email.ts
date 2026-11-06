import { createHash } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken } from "@/lib/ghl-app";
import { getSurveyFieldMap, liveAppointmentsOnCalendar, locationTimezone, parseReservedTime, wallToIso } from "@/lib/onebox";

type Svc = ReturnType<typeof createServiceClient>;

/* "Finish your deposit" email (owner, 11/03/2026). A lead who picked a time
   on the booking page but didn't pay gets two emails from her artist's GHL
   sub-account: about an hour after the pick, then a day later — each only if
   she still hasn't paid. 50/50 by a salted hash of the phone (independent of
   the deposit-ask test's last-digit split), so the hold side shows what the
   emails add. Off until the owner approves the two emails (planned 11/25);
   switching it on starts counting picks from that moment.

   Sender = the sub-account's own email sender (artist's name, LC Email domain
   booking.pmu-care.com since 11/03) — no forced header, so a reply still
   reaches the artist. The service named in the email is the one the lead
   chose on the page (owner, 11/06/2026: a scalp-only artist must never read
   "permanent makeup"); brows / lips / eyeliner name the area plus "permanent
   makeup" in full (owner: leads don't all know what PMU means); an unknown answer names no
   service at all. */

export const PICK_EMAIL_KEY = "pick_email";
export const PICK_EMAIL_PLANNED = "2026-11-25";
const GHL = "https://services.leadconnectorhq.com";
const PAID = new Set(["booked", "paid", "paid-not-booked", "paid-followup"]);
const PAID_TAGS = ["fanbasis buyer", "deposit collected"];
const FIRST_AFTER_MS = 60 * 60_000;        // email 1: an hour after the pick
const SECOND_AFTER_MS = 24 * 3600_000;     // email 2: a day after the pick
const ENROLL_LOOKBACK_MS = 3 * 86400_000;  // picks older than this aren't enrolled late
const SLOT_MARGIN_MS = 3 * 3600_000;       // no email when the picked time is this close or gone
const SEND_FROM_HOUR = 8, SEND_TO_HOUR = 21, RESUME_HOUR = 9; // lead's local clock
const MAX_ATTEMPTS = 3;
const MAX_SENDS_PER_RUN = 40;
const DEFAULT_TZ = "America/New_York";

export type PickEmailSettings = { enabled: boolean; startAt: string | null; updatedBy?: string | null };
const DEFAULTS: PickEmailSettings = { enabled: false, startAt: null };

export async function getPickEmailSettings(svc: Svc): Promise<PickEmailSettings> {
  const { data } = await svc.from("app_settings").select("value").eq("key", PICK_EMAIL_KEY).maybeSingle();
  return { ...DEFAULTS, ...((data?.value as Partial<PickEmailSettings> | null) ?? {}) };
}

/** On → counting starts now (picks before this moment are never emailed). */
export async function setPickEmailEnabled(svc: Svc, enabled: boolean, by: string): Promise<PickEmailSettings> {
  const prev = await getPickEmailSettings(svc);
  const next: PickEmailSettings = { ...prev, enabled, updatedBy: by };
  if (enabled && !prev.enabled) {
    next.startAt = new Date().toISOString();
    // Back on after a pause: whoever was mid-way from the earlier period is closed, never emailed days late.
    const { error: pe } = await svc.from("pick_email_people").update({ stopped_reason: "paused", next_due_at: null, updated_at: next.startAt })
      .is("stopped_reason", null).lt("picked_at", next.startAt);
    if (pe) throw new Error(pe.message);
  }
  const { error } = await svc.from("app_settings").upsert({ key: PICK_EMAIL_KEY, value: next, updated_by: by, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
  return next;
}

// ─── The two emails ─────────────────────────────────────────────────────────
export type EmailVars = { first: string; biz: string; when: string | null; deposit: string; link: string; service?: string | null };

/** The lead's "which area" answer → the words the email uses for the service.
    "" when the answer is missing or isn't a service we know (some funnels store
    a city there) — the email then just says "your appointment". */
export function serviceWords(area: string | null | undefined): string {
  const a = String(area ?? "").toLowerCase();
  if (/scalp|\bsmp\b/.test(a)) return "scalp micropigmentation";
  if (/removal/.test(a)) return "tattoo removal";
  if (/fine\s*line/.test(a)) return "fine line tattoo";
  if (/dark\s*circle/.test(a)) return "dark circle neutralization";
  if (/stretch/.test(a)) return "stretch mark camouflage";
  if (/scar/.test(a)) return "scar camouflage";
  // Owner, 11/06/2026: name the exact area she asked for — it converts better than the general words.
  if (/brow/.test(a)) return "eyebrow permanent makeup";
  if (/lip/.test(a)) return "lip permanent makeup";
  if (/liner/.test(a)) return "eyeliner permanent makeup";
  if (/permanent\s*make/.test(a)) return "permanent makeup";
  return "";
}
export type Email = { subject: string; html: string };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] ?? c));
const button = (link: string) =>
  `<p style="margin:22px 0"><a href="${esc(link)}" style="background:#15B7AE;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:8px;display:inline-block">Finish my booking</a></p>`;
const wrap = (inner: string) => `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1c2b3a;max-width:520px">${inner}</div>`;

/** Step 1 or 2, filled in for one lead. `when` null → the copy skips the time. */
export function pickEmail(step: 1 | 2, v: EmailVars): Email {
  const first = esc(v.first), biz = esc(v.biz), dep = esc(v.deposit), when = v.when ? esc(v.when) : null;
  const appt = v.service ? `${v.service} appointment` : "appointment"; // fixed words from serviceWords — nothing to escape
  if (step === 1) {
    return {
      subject: when ? `Finish booking your ${appt} — ${v.when}` : `Finish booking your ${appt}`,
      html: wrap(
        `<p>Hi ${first},</p>` +
        `<p>You picked ${when ? `<b>${when}</b>` : "a time"} for your ${appt} with <b>${biz}</b> — you're one step away.</p>` +
        `<p>The last step is your ${dep} deposit. It's 100% refundable: after your free consultation it goes toward your service, or you get it back in full.</p>` +
        button(v.link) +
        `<p>Until the deposit is in, that time is still open to other clients.</p>` +
        `<p>Questions? Just reply to this email.</p>` +
        `<p>${biz}</p>`,
      ),
    };
  }
  return {
    subject: when ? `Still want ${v.when}? Your ${appt} isn't booked yet` : `Your ${appt} isn't booked yet`,
    html: wrap(
      `<p>Hi ${first},</p>` +
      `<p>Just checking in — your ${appt} with <b>${biz}</b>${when ? ` on <b>${when}</b>` : ""} isn't booked yet.</p>` +
      `<p>If you still want it, it takes about a minute. Your ${dep} deposit is 100% refundable.</p>` +
      button(v.link) +
      `<p>If that time doesn't work anymore, the same link lets you choose a different time.</p>` +
      `<p>${biz}</p>`,
    ),
  };
}

/** "Saturday, November 28 at 1:00 PM" from the studio wall-clock ISO the funnel stores. */
export function fmtWhen(slotIso: string | null | undefined): string | null {
  const m = String(slotIso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  const day = d.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
  const time = d.toLocaleTimeString("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit" });
  return `${day} at ${time}`;
}

export const confirmLink = (slug: string, contactId: string) => `https://book.pmu-care.com/${slug}/${contactId}/confirm`;

/* "TAYLOR" / "carolina" → "Taylor" / "Carolina"; "McKenna" stays. */
const tidyName = (s: string) => (s === s.toUpperCase() || s === s.toLowerCase())
  ? s.replace(/[a-zÀ-ɏ]+/gi, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
  : s;
export function firstName(contactFirst: string | null | undefined, fullName: string | null | undefined): string {
  const pick = String(contactFirst ?? "").trim() || String(fullName ?? "").trim().split(/\s+/)[0] || "";
  return /^[a-zÀ-ɏ'’-]{2,}$/i.test(pick) ? tidyName(pick) : "there";
}

/** Same side for every row and re-pick of one person; unrelated to the last-digit split. */
export function pickEmailArm(phone: string): "email" | "hold" {
  const last10 = String(phone ?? "").replace(/\D/g, "").slice(-10);
  return createHash("sha256").update(`pick-email-v1:${last10}`).digest()[0] & 1 ? "email" : "hold";
}

// ─── Clock ──────────────────────────────────────────────────────────────────
function localHour(at: Date, tz: string): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(at));
}
/** `at` if it's daytime for the lead, else the next 9:00 her time (15-minute steps; DST-safe). */
export function nextDaytime(at: Date, tz: string): Date {
  const h = localHour(at, tz);
  if (h >= SEND_FROM_HOUR && h < SEND_TO_HOUR) return at;
  let t = new Date(Math.ceil(at.getTime() / 900_000) * 900_000);
  for (let i = 0; i < 4 * 30 && localHour(t, tz) !== RESUME_HOUR; i++) t = new Date(t.getTime() + 900_000);
  return t;
}
const validTz = (tz: string) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } };

// ─── The run ────────────────────────────────────────────────────────────────
type Lead = {
  slug: string; location_id: string; ghl_contact_id: string | null; ghl_status: string | null; full_name: string | null;
  phone: string | null; picked_time_at: string | null; slot_iso: string | null; paid_at: string | null; created_at: string;
  ghl_appointment_id: string | null; answers: Record<string, unknown> | null;
};
type Funnel = { slug: string; location_id: string; client_name: string | null; status: string | null; config: Record<string, unknown> | null; extras: Record<string, unknown> | null };
type Person = {
  contact_id: string; location_id: string; slug: string; arm: "email" | "hold"; picked_at: string; slot_iso: string | null; phone: string | null;
  step: number; next_due_at: string | null; attempts: number; stopped_reason: string | null;
};

const LEAD_COLS = "slug, location_id, ghl_contact_id, ghl_status, full_name, phone, picked_time_at, slot_iso, paid_at, created_at, ghl_appointment_id, answers";
const PERSON_COLS = "contact_id, location_id, slug, arm, picked_at, slot_iso, phone, step, next_due_at, attempts, stopped_reason";
// The team's own test picks ("Nicolas Test002", "Nicolas tst") and phones.
const TEAM_PHONES = new Set(["2067364980", "2064296368"]);
const last10 = (phone: string | null | undefined) => String(phone ?? "").replace(/\D/g, "").slice(-10);
const isTest = (l: Lead) => /test|\btst/i.test(String(l.full_name ?? "")) || TEAM_PHONES.has(last10(l.phone));
const isPaidLead = (l: Lead) => PAID.has(String(l.ghl_status ?? "")) || !!l.paid_at;
const STEP_MAX_AGE_MS = { 1: 24 * 3600_000, 2: 72 * 3600_000 } as const; // never "an hour ago" days later

/** Funnels whose picks get the email: live, a deposit to finish, not the agency's B2B pages. */
async function eligibleFunnels(svc: Svc): Promise<Map<string, Funnel>> {
  const { data, error } = await svc.from("onebox_clients").select("slug, location_id, client_name, status, config, extras");
  if (error) throw new Error(error.message);
  const out = new Map<string, Funnel>();
  for (const f of (data ?? []) as Funnel[]) {
    const x = f.extras ?? {};
    if (f.status !== "live" || x.template === "b2b" || x.freeBooking) continue;
    out.set(f.slug, f);
  }
  return out;
}

export type PickEmailRun = {
  enabled: boolean; dryRun: boolean; enrolled: { email: number; hold: number }; sent: number; stopped: Record<string, number>;
  errors: string[]; partial: boolean; preview?: { contactId: string; slug: string; step: number; to: string; dueAt: string; subject: string }[];
};

/* Enrol new pickers (both sides), then send what's due on the email side.
   dryRun: nothing is written or sent — returns what WOULD happen (sinceIso
   stands in for the switch-on moment so it can be tried while off). */
export async function runPickEmail(svc: Svc, opts: { dryRun?: boolean; sinceIso?: string; now?: Date; budgetMs?: number } = {}): Promise<PickEmailRun> {
  const started = Date.now();
  const budget = opts.budgetMs ?? 240_000;
  const now = opts.now ?? new Date();
  const dryRun = !!opts.dryRun;
  const settings = await getPickEmailSettings(svc);
  const res: PickEmailRun = { enabled: settings.enabled, dryRun, enrolled: { email: 0, hold: 0 }, sent: 0, stopped: {}, errors: [], partial: false };
  const startAt = dryRun ? (opts.sinceIso ?? settings.startAt) : settings.enabled ? settings.startAt : null;
  if (!startAt) return res;
  const funnels = await eligibleFunnels(svc);

  // 1. Enrol: new contacts who picked a time since the switch-on (and in the last 3 days).
  const since = new Date(Math.max(Date.parse(startAt), now.getTime() - ENROLL_LOOKBACK_MS)).toISOString();
  const fresh: Lead[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await svc.from("onebox_leads").select(LEAD_COLS)
      .gte("picked_time_at", since).not("ghl_contact_id", "is", null).order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    fresh.push(...((data ?? []) as Lead[]));
    if (!data || data.length < 1000) break;
  }
  const byContact = new Map<string, Lead[]>();
  for (const l of fresh) {
    if (!funnels.has(l.slug) || (l.answers ?? {}).disqualified || isTest(l)) continue;
    byContact.set(l.ghl_contact_id as string, [...(byContact.get(l.ghl_contact_id as string) ?? []), l]);
  }
  const ids = [...byContact.keys()];
  const known = new Set<string>();
  for (let i = 0; i < ids.length; i += 300) {
    const { data, error } = await svc.from("pick_email_people").select("contact_id").in("contact_id", ids.slice(i, i + 300));
    if (error) throw new Error(error.message);
    for (const r of data ?? []) known.add(r.contact_id as string);
  }
  const queue: Person[] = [];
  for (const [contactId, rows] of byContact) {
    if (known.has(contactId)) continue;
    const latest = [...rows].sort((a, b) => String(b.picked_time_at).localeCompare(String(a.picked_time_at)))[0];
    const firstPick = rows.map((r) => Date.parse(String(r.picked_time_at))).filter(Number.isFinite).reduce((a, b) => Math.min(a, b));
    const pickedAt = new Date(Math.max(firstPick, Date.parse(startAt)));
    const arm = pickEmailArm(latest.phone ?? "");
    const person: Person = {
      contact_id: contactId, location_id: latest.location_id, slug: latest.slug, arm, picked_at: pickedAt.toISOString(),
      slot_iso: latest.slot_iso, phone: latest.phone, step: 0, attempts: 0,
      next_due_at: arm === "email" ? new Date(pickedAt.getTime() + FIRST_AFTER_MS).toISOString() : null,
      stopped_reason: arm === "email" ? null : "hold",
    };
    res.enrolled[arm]++;
    if (dryRun) { if (arm === "email") queue.push(person); continue; }
    const { error } = await svc.from("pick_email_people").insert(person);
    if (error && !/duplicate key/i.test(error.message)) res.errors.push(`enrol ${contactId}: ${error.message}`);
  }

  // 2. Send what's due (the email side only; picks from an earlier switched-on period never resume).
  let due: Person[] = queue.filter((p) => Date.parse(p.next_due_at as string) <= now.getTime());
  if (!dryRun) {
    const { data, error } = await svc.from("pick_email_people").select(PERSON_COLS)
      .eq("arm", "email").is("stopped_reason", null).lt("step", 2).lte("next_due_at", now.toISOString()).gte("picked_at", startAt)
      .order("next_due_at").limit(MAX_SENDS_PER_RUN);
    if (error) throw new Error(error.message);
    due = (data ?? []) as Person[];
  }
  if (dryRun) res.preview = [];

  const toks = new Map<string, string | null>();
  const tokenFor = async (loc: string) => {
    if (!toks.has(loc)) toks.set(loc, (await getAppLocationToken(loc)).token ?? null);
    return toks.get(loc) ?? null;
  };
  const stamp = () => new Date().toISOString();
  const stop = async (p: Person, reason: string) => {
    res.stopped[reason] = (res.stopped[reason] ?? 0) + 1;
    if (dryRun) return;
    await svc.from("pick_email_people").update({ stopped_reason: reason, next_due_at: null, updated_at: stamp() }).eq("contact_id", p.contact_id);
  };
  /* Couldn't decide this run (GHL or the database unreachable): try again in
     30 minutes, give up after 3 tries — a stuck row never blocks the queue. */
  const later = async (p: Person, why: string) => {
    res.errors.push(`${p.slug}: ${why}`);
    if (dryRun) return;
    const attempts = p.attempts + 1;
    await svc.from("pick_email_people").update({
      attempts, send_error: why.slice(0, 300), updated_at: stamp(),
      next_due_at: attempts >= MAX_ATTEMPTS ? null : new Date(now.getTime() + 30 * 60_000).toISOString(),
      stopped_reason: attempts >= MAX_ATTEMPTS ? "failed" : null,
    }).eq("contact_id", p.contact_id);
  };

  for (const p of due.slice(0, MAX_SENDS_PER_RUN)) {
    if (Date.now() - started > budget) { res.partial = true; break; }
    try {
      const step = (p.step + 1) as 1 | 2;
      // The client may have been paused / switched to free booking since the pick.
      const funnel = funnels.get(p.slug);
      if (!funnel) { await stop(p, "funnel_off"); continue; }
      if (now.getTime() - Date.parse(p.picked_at) > STEP_MAX_AGE_MS[step]) { await stop(p, "too_late"); continue; }

      // Paid on any of her rows for this funnel (by contact, or the same phone)? Unreadable → decide later, never send blind.
      const { data: rowsData, error: re } = await svc.from("onebox_leads").select(LEAD_COLS).eq("slug", p.slug).eq("ghl_contact_id", p.contact_id);
      if (re) { await later(p, `lead rows: ${re.message}`); continue; }
      const rows = (rowsData ?? []) as Lead[];
      if (!rows.length) { await stop(p, "no_lead_row"); continue; }
      const phone10 = last10(p.phone ?? rows[0].phone);
      let samePhone: Lead[] = [];
      if (phone10.length === 10) {
        const { data, error } = await svc.from("onebox_leads").select(LEAD_COLS).eq("slug", p.slug).ilike("phone", `%${phone10.slice(-4)}%`)
          .gte("created_at", new Date(Date.parse(p.picked_at) - 30 * 86400_000).toISOString());
        if (error) { await later(p, `same-phone rows: ${error.message}`); continue; }
        samePhone = ((data ?? []) as Lead[]).filter((l) => last10(l.phone) === phone10);
      }
      if ([...rows, ...samePhone].some(isPaidLead)) { await stop(p, "paid"); continue; }

      const tok = await tokenFor(p.location_id);
      if (!tok) { await later(p, "no GHL token for the sub-account"); continue; }
      const H = { Authorization: `Bearer ${tok}`, Version: "2021-07-28", Accept: "application/json" };
      const cr = await fetch(`${GHL}/contacts/${encodeURIComponent(p.contact_id)}`, { headers: H });
      // GHL answers a deleted or merged contact with 400 as well as 404.
      if (cr.status === 404 || cr.status === 400) { await stop(p, "contact_gone"); continue; }
      if (!cr.ok) { await later(p, `contact read ${cr.status}`); continue; }
      const c = ((await cr.json()) as { contact?: Record<string, unknown> }).contact ?? {};
      const tags = ((c.tags as string[] | undefined) ?? []).map((t) => String(t).toLowerCase());
      if (tags.some((t) => PAID_TAGS.includes(t))) { await stop(p, "paid"); continue; }
      const email = String(c.email ?? "").trim();
      if (!email) { await stop(p, "no_email"); continue; }
      const dnd = (c.dndSettings ?? {}) as Record<string, { status?: string } | undefined>;
      const emailDndStatus = String(dnd.Email?.status ?? "").toLowerCase();
      if (c.dnd === true || (emailDndStatus && emailDndStatus !== "inactive")) { await stop(p, "email_dnd"); continue; }

      // Paid with this email on the funnel's checkout since the pick (before GHL tags her)?
      const cfg = funnel.config ?? {};
      const productId = String(cfg.fanbasisProductId ?? "").trim();
      if (productId) {
        // "_" and "%" are wildcards to ilike — escaped so it's a case-blind exact match.
        const { data: deps, error: de } = await svc.from("deposits").select("data").ilike("data->>Email", email.replace(/[\\%_]/g, (ch) => `\\${ch}`)).limit(50);
        if (de) { await later(p, `deposits: ${de.message}`); continue; }
        const pickDay = Date.parse(p.picked_at.slice(0, 10)) - 86400_000;
        const paidHere = (deps ?? []).some((d) => {
          const row = (d.data ?? {}) as Record<string, unknown>;
          if (String(row["Product ID"] ?? "").trim() !== productId) return false;
          const m = String(row.Date ?? "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // DD/MM/YYYY
          return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) >= pickDay : false;
        });
        if (paidHere) { await stop(p, "paid"); continue; }
      }

      /* The time the link will open — worked out exactly as /api/onebox/paylead
         does (an appointment already booked in chat, then the reserved-time
         field, then her funnel pick while it's ahead), so the email never
         names a different time than the page offers (Alma Tejeda, 09/30). A
         confirmed booking from the last 3 weeks = she's booked; no email. */
      const locTz = await locationTimezone(p.location_id, tok);
      const calendarId = String(cfg.calendarId ?? "");
      const recent = now.getTime() - 21 * 86400_000;
      const paidIds = new Set(rows.map((r) => String(r.ghl_appointment_id ?? "")).filter(Boolean));
      let booked = "";
      if (calendarId) {
        const appts = await liveAppointmentsOnCalendar(p.contact_id, calendarId, p.location_id, tok);
        if (!appts.ok) { await later(p, `appointments: ${appts.error ?? "unreadable"}`); continue; }
        const live = appts.appts.filter((a) => (a.addedMs || 0) >= recent);
        if (live.some((a) => a.status === "confirmed" && (a.addedMs || 0) < now.getTime() - 15 * 60_000)) { await stop(p, "booked"); continue; }
        booked = live.find((a) => !paidIds.has(a.id))?.startIso ?? "";
      }
      let reserved = "";
      const fieldMap = await getSurveyFieldMap(p.location_id, tok);
      const rf = fieldMap.reserved_time ? ((c.customFields as { id?: string; value?: unknown }[] | undefined) ?? []).find((x) => x.id === fieldMap.reserved_time) : undefined;
      if (rf?.value) {
        const wall = parseReservedTime(String(rf.value));
        reserved = wall && locTz ? wallToIso(wall, locTz) : wall;
      }
      const ahead = (iso: string) => (iso && Date.parse(iso) > now.getTime() ? iso : "");
      const latest = [...rows].sort((a, b) => String(b.picked_time_at).localeCompare(String(a.picked_time_at)))[0];
      const slotIso = booked || ahead(reserved) || ahead(String(latest.slot_iso ?? p.slot_iso ?? ""));
      // No time ahead, or it's about to start → nothing left to finish.
      if (!slotIso || Date.parse(slotIso) - now.getTime() < SLOT_MARGIN_MS) { await stop(p, "slot_passed"); continue; }

      // Night for the lead → wait for her morning.
      const contactTz = String(c.timezone ?? "");
      const tz = validTz(contactTz) ? contactTz : locTz && validTz(locTz) ? locTz : DEFAULT_TZ;
      const sendAt = nextDaytime(now, tz);
      if (sendAt.getTime() > now.getTime() + 60_000 && !dryRun) {
        await svc.from("pick_email_people").update({ next_due_at: sendAt.toISOString(), updated_at: stamp() }).eq("contact_id", p.contact_id);
        continue;
      }

      const msg = pickEmail(step, {
        first: firstName(String(c.firstName ?? ""), latest.full_name),
        biz: String(cfg.biz ?? "").trim() || String(funnel.client_name ?? "").trim() || "your artist",
        when: fmtWhen(slotIso),
        deposit: String(cfg.deposit ?? "").trim() || "$50",
        link: confirmLink(p.slug, p.contact_id),
        service: serviceWords(String((latest.answers as Record<string, unknown> | null)?.area ?? "")),
      });
      if (dryRun) {
        res.preview!.push({ contactId: p.contact_id, slug: p.slug, step, to: email.replace(/^(.).*(@.*)$/, "$1…$2"), dueAt: sendAt.toISOString(), subject: msg.subject });
        continue;
      }

      // Claim the step before sending — a crash can lose one email, never send it twice.
      const nextDue = step === 1 ? new Date(Math.max(Date.parse(p.picked_at) + SECOND_AFTER_MS, now.getTime() + 12 * 3600_000)).toISOString() : null;
      const { data: claimed } = await svc.from("pick_email_people")
        .update({ step, [`sent${step}_at`]: now.toISOString(), next_due_at: nextDue, stopped_reason: step === 2 ? "finished" : null, slot_iso: slotIso, updated_at: stamp() })
        .eq("contact_id", p.contact_id).eq("step", p.step).is("stopped_reason", null).select("contact_id");
      if (!claimed?.length) continue;
      const sr = await fetch(`${GHL}/conversations/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, Version: "2021-04-15", "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ type: "Email", contactId: p.contact_id, subject: msg.subject, html: msg.html }),
      });
      if (sr.ok) {
        res.sent++;
        await svc.from("pick_email_people").update({ attempts: 0, send_error: null }).eq("contact_id", p.contact_id);
        continue;
      }
      const err = `HTTP ${sr.status}: ${(await sr.text().catch(() => "")).slice(0, 180)}`;
      res.errors.push(`${p.slug}: ${err}`);
      /* A 5xx may have gone out anyway (GHL's gateway can time out after
         queueing it) — keep the claim: one possibly-missed email beats a
         double. Only a clear refusal hands the step back for a retry. */
      if (sr.status >= 500) {
        await svc.from("pick_email_people").update({ send_error: err, updated_at: stamp() }).eq("contact_id", p.contact_id);
        continue;
      }
      const attempts = p.attempts + 1;
      const optOut = /\bdnd\b|do not disturb|opt(ed)?[\s-]?out|unsubscrib/i.test(err);
      await svc.from("pick_email_people").update({
        step: p.step, [`sent${step}_at`]: null, attempts, send_error: err,
        next_due_at: optOut || attempts >= MAX_ATTEMPTS ? null : new Date(now.getTime() + 30 * 60_000).toISOString(),
        stopped_reason: optOut ? "email_dnd" : attempts >= MAX_ATTEMPTS ? "failed" : null, updated_at: stamp(),
      }).eq("contact_id", p.contact_id);
    } catch (e) {
      await later(p, e instanceof Error ? e.message : String(e)).catch(() => {});
    }
  }
  return res;
}

// ─── Readout (Funnels card) ─────────────────────────────────────────────────
export type PickEmailSide = { people: number; open: number; paid: number; paidPct: number | null };
export type PickEmailSummary = {
  settings: PickEmailSettings; planned: string;
  sides: { email: PickEmailSide; hold: PickEmailSide };
  sent: { first: number; second: number }; stopped: Record<string, number>; errors: number; lastError: string | null;
};

/* Both sides measured the same way: paid = one of her funnel rows paid within
   7 days of the pick. "Open" = hadn't paid in the first hour (the moment the
   first email goes out) — the fair base for the comparison. A paid row with
   no payment time (older rows, admin follow-ups) only counts when the row
   itself belongs to this pick — never an earlier visit's deposit. */
export async function pickEmailSummary(svc: Svc): Promise<PickEmailSummary> {
  const settings = await getPickEmailSettings(svc);
  type Row = Person & { sent1_at: string | null; sent2_at: string | null; send_error: string | null; updated_at: string };
  const people: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await svc.from("pick_email_people").select(`${PERSON_COLS}, sent1_at, sent2_at, send_error, updated_at`).order("contact_id").range(from, from + 999);
    if (error) throw new Error(error.message);
    people.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) break;
  }
  const pickOf = new Map(people.map((p) => [p.contact_id, Date.parse(p.picked_at)]));
  // Per contact: the earliest payment tied to this pick; null = paid, time unknown.
  const paidAt = new Map<string, number | null>();
  const ids = people.map((p) => p.contact_id);
  for (let i = 0; i < ids.length; i += 300) {
    const { data, error } = await svc.from("onebox_leads").select("ghl_contact_id, ghl_status, paid_at, created_at").in("ghl_contact_id", ids.slice(i, i + 300));
    if (error) throw new Error(error.message);
    for (const r of data ?? []) {
      const id = r.ghl_contact_id as string, pick = pickOf.get(id) ?? 0;
      if (!PAID.has(String(r.ghl_status ?? "")) && !r.paid_at) continue;
      const t = r.paid_at ? Date.parse(r.paid_at as string) : null;
      if (t != null ? t < pick - 3600_000 : Date.parse(r.created_at as string) < pick - 2 * 86400_000) continue; // an earlier visit's deposit
      const prev = paidAt.get(id);
      paidAt.set(id, prev === undefined ? t : prev == null ? t : t == null ? prev : Math.min(prev, t));
    }
  }
  const side = (arm: "email" | "hold"): PickEmailSide => {
    const ps = people.filter((p) => p.arm === arm);
    let open = 0, paid = 0;
    for (const p of ps) {
      const pick = Date.parse(p.picked_at);
      const at = paidAt.get(p.contact_id); // undefined = not paid
      if (at != null && at <= pick + FIRST_AFTER_MS) continue; // paid on the page right away
      open++;
      if (at === null || (at !== undefined && at <= pick + 7 * 86400_000)) paid++;
    }
    return { people: ps.length, open, paid, paidPct: open ? Math.round((paid / open) * 1000) / 10 : null };
  };
  const stopped: Record<string, number> = {};
  for (const p of people) if (p.arm === "email" && p.stopped_reason) stopped[p.stopped_reason] = (stopped[p.stopped_reason] ?? 0) + 1;
  const errs = people.filter((p) => p.send_error).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return {
    settings, planned: PICK_EMAIL_PLANNED,
    sides: { email: side("email"), hold: side("hold") },
    sent: { first: people.filter((p) => p.sent1_at).length, second: people.filter((p) => p.sent2_at).length },
    stopped, errors: errs.length, lastError: errs[0]?.send_error ?? null,
  };
}
