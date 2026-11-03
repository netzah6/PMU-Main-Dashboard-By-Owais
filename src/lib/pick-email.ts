import { createHash } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken } from "@/lib/ghl-app";
import { locationTimezone } from "@/lib/onebox";

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
   reaches the artist. The subject always says "permanent makeup" (owner:
   leads don't all know what PMU means). */

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
  if (enabled && !prev.enabled) next.startAt = new Date().toISOString();
  const { error } = await svc.from("app_settings").upsert({ key: PICK_EMAIL_KEY, value: next, updated_by: by, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
  return next;
}

// ─── The two emails ─────────────────────────────────────────────────────────
export type EmailVars = { first: string; biz: string; when: string | null; deposit: string; link: string };
export type Email = { subject: string; html: string };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] ?? c));
const button = (link: string) =>
  `<p style="margin:22px 0"><a href="${esc(link)}" style="background:#15B7AE;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:8px;display:inline-block">Finish my booking</a></p>`;
const wrap = (inner: string) => `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1c2b3a;max-width:520px">${inner}</div>`;

/** Step 1 or 2, filled in for one lead. `when` null → the copy skips the time. */
export function pickEmail(step: 1 | 2, v: EmailVars): Email {
  const first = esc(v.first), biz = esc(v.biz), dep = esc(v.deposit), when = v.when ? esc(v.when) : null;
  if (step === 1) {
    return {
      subject: when ? `Finish booking your permanent makeup appointment — ${v.when}` : "Finish booking your permanent makeup appointment",
      html: wrap(
        `<p>Hi ${first},</p>` +
        `<p>You picked ${when ? `<b>${when}</b>` : "a time"} for your permanent makeup appointment with <b>${biz}</b> — you're one step away.</p>` +
        `<p>The last step is your ${dep} deposit. It's 100% refundable: after your free consultation it goes toward your service, or you get it back in full.</p>` +
        button(v.link) +
        `<p>Until the deposit is in, that time is still open to other clients.</p>` +
        `<p>Questions? Just reply to this email.</p>` +
        `<p>${biz}</p>`,
      ),
    };
  }
  return {
    subject: when ? `Still want ${v.when}? Your permanent makeup appointment isn't booked yet` : "Your permanent makeup appointment isn't booked yet",
    html: wrap(
      `<p>Hi ${first},</p>` +
      `<p>Just checking in — your permanent makeup appointment with <b>${biz}</b>${when ? ` on <b>${when}</b>` : ""} isn't booked yet.</p>` +
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
  answers: Record<string, unknown> | null;
};
type Funnel = { slug: string; location_id: string; client_name: string | null; status: string | null; config: Record<string, unknown> | null; extras: Record<string, unknown> | null };
type Person = {
  contact_id: string; location_id: string; slug: string; arm: "email" | "hold"; picked_at: string; slot_iso: string | null;
  step: number; next_due_at: string | null; attempts: number; stopped_reason: string | null;
};

const LEAD_COLS = "slug, location_id, ghl_contact_id, ghl_status, full_name, phone, picked_time_at, slot_iso, paid_at, created_at, answers";
const isTest = (name: string | null) => /\btest(ing)?\b/i.test(String(name ?? ""));
const isPaidLead = (l: Lead) => PAID.has(String(l.ghl_status ?? "")) || !!l.paid_at;

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
  const { data: fresh, error: fe } = await svc.from("onebox_leads").select(LEAD_COLS)
    .gte("picked_time_at", since).not("ghl_contact_id", "is", null).limit(5000);
  if (fe) throw new Error(fe.message);
  const byContact = new Map<string, Lead[]>();
  for (const l of (fresh ?? []) as Lead[]) {
    if (!funnels.has(l.slug) || (l.answers ?? {}).disqualified || isTest(l.full_name)) continue;
    byContact.set(l.ghl_contact_id as string, [...(byContact.get(l.ghl_contact_id as string) ?? []), l]);
  }
  const ids = [...byContact.keys()];
  const known = new Set<string>();
  for (let i = 0; i < ids.length; i += 300) {
    const { data } = await svc.from("pick_email_people").select("contact_id").in("contact_id", ids.slice(i, i + 300));
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
      slot_iso: latest.slot_iso, step: 0, attempts: 0,
      next_due_at: arm === "email" ? new Date(pickedAt.getTime() + FIRST_AFTER_MS).toISOString() : null,
      stopped_reason: arm === "email" ? null : "hold",
    };
    res.enrolled[arm]++;
    if (dryRun) { if (arm === "email") queue.push(person); continue; }
    const { error } = await svc.from("pick_email_people").insert(person);
    if (error && !/duplicate key/i.test(error.message)) res.errors.push(`enrol ${contactId}: ${error.message}`);
  }

  // 2. Send what's due (the email side only).
  let due: Person[] = queue.filter((p) => Date.parse(p.next_due_at as string) <= now.getTime());
  if (!dryRun) {
    const { data, error } = await svc.from("pick_email_people")
      .select("contact_id, location_id, slug, arm, picked_at, slot_iso, step, next_due_at, attempts, stopped_reason")
      .eq("arm", "email").is("stopped_reason", null).lt("step", 2).lte("next_due_at", now.toISOString())
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
  const stop = async (p: Person, reason: string, extra: Record<string, unknown> = {}) => {
    res.stopped[reason] = (res.stopped[reason] ?? 0) + 1;
    if (dryRun) return;
    await svc.from("pick_email_people").update({ stopped_reason: reason, next_due_at: null, updated_at: new Date().toISOString(), ...extra }).eq("contact_id", p.contact_id);
  };

  for (const p of due.slice(0, MAX_SENDS_PER_RUN)) {
    if (Date.now() - started > budget) { res.partial = true; break; }
    try {
      const step = (p.step + 1) as 1 | 2;
      // Paid on any of her rows for this funnel (by contact, or the same phone)?
      const { data: rowsData } = await svc.from("onebox_leads").select(LEAD_COLS).eq("slug", p.slug).eq("ghl_contact_id", p.contact_id);
      const rows = (rowsData ?? []) as Lead[];
      const last10 = String(rows[0]?.phone ?? "").replace(/\D/g, "").slice(-10);
      let samePhone: Lead[] = [];
      if (last10.length === 10) {
        const { data } = await svc.from("onebox_leads").select(LEAD_COLS).eq("slug", p.slug).ilike("phone", `%${last10.slice(-4)}%`).gte("created_at", new Date(Date.parse(p.picked_at) - 30 * 86400_000).toISOString());
        samePhone = ((data ?? []) as Lead[]).filter((l) => String(l.phone ?? "").replace(/\D/g, "").slice(-10) === last10);
      }
      if ([...rows, ...samePhone].some(isPaidLead)) { await stop(p, "paid"); continue; }
      const latest = [...rows].sort((a, b) => String(b.picked_time_at).localeCompare(String(a.picked_time_at)))[0];
      const slotIso = latest?.slot_iso ?? p.slot_iso;

      const tok = await tokenFor(p.location_id);
      if (!tok) { res.errors.push(`${p.slug}: no GHL token`); continue; }
      const H = { Authorization: `Bearer ${tok}`, Version: "2021-07-28", Accept: "application/json" };
      const cr = await fetch(`${GHL}/contacts/${encodeURIComponent(p.contact_id)}`, { headers: H });
      if (cr.status === 404) { await stop(p, "contact_gone"); continue; }
      if (!cr.ok) { res.errors.push(`${p.slug}: contact read ${cr.status}`); continue; }
      const c = ((await cr.json()) as { contact?: Record<string, unknown> }).contact ?? {};
      const tags = ((c.tags as string[] | undefined) ?? []).map((t) => String(t).toLowerCase());
      if (tags.some((t) => PAID_TAGS.includes(t))) { await stop(p, "paid"); continue; }
      const email = String(c.email ?? "").trim();
      if (!email) { await stop(p, "no_email"); continue; }
      const dnd = (c.dndSettings ?? {}) as Record<string, { status?: string } | undefined>;
      const emailDndStatus = String(dnd.Email?.status ?? "").toLowerCase();
      if (c.dnd === true || (emailDndStatus && emailDndStatus !== "inactive")) { await stop(p, "email_dnd"); continue; }

      // Paid with this email on the funnel's checkout since the pick (before GHL tags her)?
      const funnel = funnels.get(p.slug);
      const productId = String(funnel?.config?.fanbasisProductId ?? "");
      if (productId) {
        // "_" and "%" are wildcards to ilike — escaped so it's a case-blind exact match.
        const { data: deps } = await svc.from("deposits").select("data").ilike("data->>Email", email.replace(/[\\%_]/g, (ch) => `\\${ch}`)).limit(50);
        const pickDay = Date.parse(p.picked_at.slice(0, 10)) - 86400_000;
        const paidHere = (deps ?? []).some((d) => {
          const row = (d.data ?? {}) as Record<string, unknown>;
          if (String(row["Product ID"] ?? "").trim() !== productId) return false;
          const m = String(row.Date ?? "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // DD/MM/YYYY
          return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) >= pickDay : false;
        });
        if (paidHere) { await stop(p, "paid"); continue; }
      }

      // The picked time is gone or about to be — nothing to finish.
      const m = String(slotIso ?? "").match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)([+-]\d{2}:\d{2}|Z)?/);
      const slotMs = m ? Date.parse(m[1] + (m[2] ?? "Z")) : NaN;
      if (Number.isFinite(slotMs) && slotMs - now.getTime() < SLOT_MARGIN_MS) { await stop(p, "slot_passed"); continue; }

      // Night for the lead → wait for her morning.
      const locTz = await locationTimezone(p.location_id, tok);
      const contactTz = String(c.timezone ?? "");
      const tz = validTz(contactTz) ? contactTz : validTz(locTz) ? locTz : DEFAULT_TZ;
      const sendAt = nextDaytime(now, tz);
      if (sendAt.getTime() > now.getTime() + 60_000 && !dryRun) {
        await svc.from("pick_email_people").update({ next_due_at: sendAt.toISOString(), updated_at: new Date().toISOString() }).eq("contact_id", p.contact_id);
        continue;
      }

      const cfg = funnel?.config ?? {};
      const msg = pickEmail(step, {
        first: firstName(String(c.firstName ?? ""), latest?.full_name ?? null),
        biz: String(cfg.biz ?? "").trim() || String(funnel?.client_name ?? "").trim() || "your artist",
        when: Number.isFinite(slotMs) ? fmtWhen(slotIso) : null,
        deposit: String(cfg.deposit ?? "").trim() || "$50",
        link: confirmLink(p.slug, p.contact_id),
      });
      if (dryRun) {
        res.preview!.push({ contactId: p.contact_id, slug: p.slug, step, to: email.replace(/^(.).*(@.*)$/, "$1…$2"), dueAt: sendAt.toISOString(), subject: msg.subject });
        continue;
      }

      // Claim the step before sending — a crash can lose one email, never send it twice.
      const nextDue = step === 1 ? new Date(Math.max(Date.parse(p.picked_at) + SECOND_AFTER_MS, now.getTime() + 12 * 3600_000)).toISOString() : null;
      const { data: claimed } = await svc.from("pick_email_people")
        .update({ step, [`sent${step}_at`]: now.toISOString(), next_due_at: nextDue, stopped_reason: step === 2 ? "finished" : null, updated_at: now.toISOString() })
        .eq("contact_id", p.contact_id).eq("step", p.step).is("stopped_reason", null).select("contact_id");
      if (!claimed?.length) continue;
      const sr = await fetch(`${GHL}/conversations/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, Version: "2021-04-15", "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ type: "Email", contactId: p.contact_id, subject: msg.subject, html: msg.html }),
      });
      if (sr.ok) { res.sent++; continue; }
      const err = `HTTP ${sr.status}: ${(await sr.text().catch(() => "")).slice(0, 180)}`;
      const attempts = p.attempts + 1;
      const optOut = /\bdnd\b|do not disturb|opt(ed)?[\s-]?out|unsubscrib/i.test(err);
      // Hand the step back so the next run retries (up to 3 tries).
      await svc.from("pick_email_people").update({
        step: p.step, [`sent${step}_at`]: null, attempts, send_error: err,
        next_due_at: optOut || attempts >= MAX_ATTEMPTS ? null : new Date(now.getTime() + 30 * 60_000).toISOString(),
        stopped_reason: optOut ? "email_dnd" : attempts >= MAX_ATTEMPTS ? "failed" : null, updated_at: new Date().toISOString(),
      }).eq("contact_id", p.contact_id);
      res.errors.push(`${p.slug}: ${err}`);
    } catch (e) {
      res.errors.push(`${p.slug}: ${e instanceof Error ? e.message : String(e)}`);
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

/* Both sides measured the same way: paid = any of her funnel rows paid within
   7 days of the pick. "Open" = hadn't paid in the first hour (the moment the
   first email goes out) — the fair base for the comparison. */
export async function pickEmailSummary(svc: Svc): Promise<PickEmailSummary> {
  const settings = await getPickEmailSettings(svc);
  const people: (Person & { sent1_at: string | null; sent2_at: string | null; send_error: string | null })[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await svc.from("pick_email_people").select("contact_id, location_id, slug, arm, picked_at, slot_iso, step, next_due_at, attempts, stopped_reason, sent1_at, sent2_at, send_error").order("contact_id").range(from, from + 999);
    if (error) throw new Error(error.message);
    people.push(...((data ?? []) as typeof people));
    if (!data || data.length < 1000) break;
  }
  const paidAt = new Map<string, number | null>();
  const ids = people.map((p) => p.contact_id);
  for (let i = 0; i < ids.length; i += 300) {
    const { data } = await svc.from("onebox_leads").select("ghl_contact_id, ghl_status, paid_at").in("ghl_contact_id", ids.slice(i, i + 300));
    for (const r of data ?? []) {
      if (!PAID.has(String(r.ghl_status ?? "")) && !r.paid_at) continue;
      const t = r.paid_at ? Date.parse(r.paid_at as string) : null;
      const prev = paidAt.get(r.ghl_contact_id as string);
      paidAt.set(r.ghl_contact_id as string, prev == null ? t : t == null ? prev : Math.min(prev, t));
    }
  }
  const side = (arm: "email" | "hold"): PickEmailSide => {
    const ps = people.filter((p) => p.arm === arm);
    let open = 0, paid = 0;
    for (const p of ps) {
      const pick = Date.parse(p.picked_at);
      const at = paidAt.has(p.contact_id) ? paidAt.get(p.contact_id) : undefined;
      if (at != null && at <= pick + FIRST_AFTER_MS) continue; // paid on the page right away
      open++;
      if (at === null || (at !== undefined && at <= pick + 7 * 86400_000)) paid++;
    }
    return { people: ps.length, open, paid, paidPct: open ? Math.round((paid / open) * 1000) / 10 : null };
  };
  const stopped: Record<string, number> = {};
  for (const p of people) if (p.arm === "email" && p.stopped_reason) stopped[p.stopped_reason] = (stopped[p.stopped_reason] ?? 0) + 1;
  const errs = people.filter((p) => p.send_error);
  return {
    settings, planned: PICK_EMAIL_PLANNED,
    sides: { email: side("email"), hold: side("hold") },
    sent: { first: people.filter((p) => p.sent1_at).length, second: people.filter((p) => p.sent2_at).length },
    stopped, errors: errs.length, lastError: errs[0]?.send_error ?? null,
  };
}
