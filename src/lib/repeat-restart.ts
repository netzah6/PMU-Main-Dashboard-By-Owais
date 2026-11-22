import type { SupabaseClient } from "@supabase/supabase-js";
import { getAppLocationToken } from "@/lib/ghl-app";

/* Repeat sign-ups (owner, 11/22/2026). A lead who fills in the one-box form
   again weeks later already has the "onebox-survey" tag from her first visit.
   Our push adds the tag again, GHL sees nothing new, and the survey workflow
   (trigger: Contact Tag added "onebox-survey") never starts — so she gets no
   text at all (proven in GHL audit + execution logs for 3 leads, 11/22).
   Fix: on a real repeat, take her out of the survey (and the nurture follow-
   up it hands her to), take the tag off and put it back, so the survey
   starts again from its first text. Out of the workflow first, because GHL
   skips a re-entry while she is still enrolled ("Add to workflow - Skipped",
   seen on Demo 11/22) and the survey's no-reply ladder runs for days. The
   survey turns the AI off at its start and back on at her first reply
   (owner: the AI should come back on for a new request, also after an
   artist took over).

   A repeat = an earlier QUALIFIED form for this contact, or (an earlier
   visit that stopped at the phone step leaves no row) the survey tag plus a
   text to her from before this visit. Left alone:
   - another qualified form of hers inside `minGapHours` (same visit, or that
     form already restarted it),
   - she paid or booked (our rows, paid/booked tags, a live GHL appointment),
   - SMS DND (any status but "inactive" — a STOP reply is "permanent"),
   - any real text in or out in the last `quietHours` (she is mid-chat).
   Ships OFF: app_settings "repeat_restart" {enabled, locations}. */

type Svc = SupabaseClient;
const GHL = "https://services.leadconnectorhq.com";
export const REPEAT_RESTART_KEY = "repeat_restart";
const PAID_STATUS = new Set(["booked", "paid", "paid-not-booked", "paid-followup"]);
const PAID_TAGS = ["fanbasis buyer", "deposit collected"];
// "booked" = the AI booked her a time (CloseBot); "onebox-booked" = our paid booking.
const BOOKED_TAGS = ["booked", "onebox-booked"];
// An appointment in any of these states is not a booking she still has.
const DEAD_APPT = new Set(["cancelled", "canceled", "invalid", "noshow", "no_show"]);
// Workflows she leaves before the restart: the survey itself and its nurture follow-up.
const LEAVE_WORKFLOWS = [/^\s*cc\s*-?\s*funnel survey/i, /follow[\s-]*up nurture/i];

export interface RepeatRestartSettings {
  enabled: boolean;
  /** location ids it may run in; null/absent = every account */
  locations?: string[] | null;
  minGapHours: number;
  quietHours: number;
}
const DEFAULTS: RepeatRestartSettings = { enabled: false, locations: null, minGapHours: 24, quietHours: 24 };

export async function getRepeatRestartSettings(svc: Svc): Promise<RepeatRestartSettings> {
  const { data } = await svc.from("app_settings").select("value").eq("key", REPEAT_RESTART_KEY).maybeSingle();
  return { ...DEFAULTS, ...((data?.value as Partial<RepeatRestartSettings> | null) ?? {}) };
}

export type RepeatRestartResult =
  | "off" // switch off for this account
  | "not_repeat" // her first qualified form
  | "skipped" // a repeat, but a rule says leave her alone (see reason)
  | "would_restart" // dry run: every rule passed
  | "restarted" // out of the old run, tag off and back on, tag confirmed on the contact
  | "failed"; // something could not be read or written (see reason)

export interface RepeatRestart {
  result: RepeatRestartResult;
  reason?: string;
  /** her newest earlier qualified form, or "ghl" when only GHL showed the earlier visit */
  prevAt?: string;
  /** workflows she was taken out of (names), for the record */
  left?: string[];
}

export interface RepeatRestartInput {
  locationId: string;
  contactId: string;
  /** the onebox_leads row of THIS form: only rows before it count as earlier */
  newLeadId: number | null;
  surveyTag: string;
  /** read and decide only — never touches the contact */
  dryRun?: boolean;
  /** tests only: run even when the switch is off for this account */
  ignoreSwitch?: boolean;
  /** tests only: replace the quiet window */
  quietHoursOverride?: number;
}

const H = (tok: string) => ({ Authorization: `Bearer ${tok}`, Version: "2021-07-28", "Content-Type": "application/json", Accept: "application/json" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* A GHL read, tried twice: one slow or 429/5xx answer must not cost her the
   restart (Demo test 3, 11/22: one messages read timed out). Never throws. */
async function getJson<T>(url: string, headers: Record<string, string>): Promise<T | null> {
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
      if (r.ok) return (await r.json()) as T;
      if (r.status !== 429 && r.status < 500) return null;
    } catch { /* timeout or network: try once more */ }
    if (i === 0) await sleep(1500);
  }
  return null;
}

interface GhlContact { tags?: string[]; dnd?: boolean; dndSettings?: Record<string, { status?: string } | undefined> }

async function readContact(tok: string, contactId: string): Promise<GhlContact | null> {
  const j = await getJson<{ contact?: GhlContact }>(`${GHL}/contacts/${encodeURIComponent(contactId)}`, H(tok));
  return j?.contact ?? null;
}

/** Newest real message either way, and oldest text/call/email TO her (ms; 0 = none). null = could not read. */
async function messageTimes(tok: string, locationId: string, contactId: string): Promise<{ newest: number; oldestOut: number } | null> {
  try {
    const hdr = { ...H(tok), Version: "2021-04-15" };
    const sj = await getJson<{ conversations?: { id: string }[] }>(`${GHL}/conversations/search?locationId=${encodeURIComponent(locationId)}&contactId=${encodeURIComponent(contactId)}`, hdr);
    if (!sj) return null;
    const convs = sj.conversations ?? [];
    let newest = 0, oldestOut = 0;
    for (const cv of convs.slice(0, 3)) {
      const mj = await getJson<{ messages?: { messages?: { dateAdded?: string; messageType?: string; direction?: string }[] } }>(`${GHL}/conversations/${encodeURIComponent(cv.id)}/messages?limit=50`, hdr);
      if (!mj) return null;
      const msgs = mj.messages?.messages ?? [];
      for (const m of msgs) {
        // Activity rows (opportunity created, appointment changed …) are not a chat.
        if (String(m.messageType ?? "").startsWith("TYPE_ACTIVITY")) continue;
        const t = Date.parse(String(m.dateAdded ?? ""));
        if (!t) continue;
        if (t > newest) newest = t;
        if (m.direction === "outbound" && (!oldestOut || t < oldestOut)) oldestOut = t;
      }
    }
    return { newest, oldestOut };
  } catch {
    return null;
  }
}

/** A booking she still has (any calendar): true / false, null = could not read. */
async function hasLiveAppointment(tok: string, contactId: string): Promise<boolean | null> {
  const j = await getJson<{ events?: { appointmentStatus?: string; deleted?: boolean }[] }>(`${GHL}/contacts/${encodeURIComponent(contactId)}/appointments`, H(tok));
  if (!j) return null;
  return (j.events ?? []).some((e) => !e.deleted && !DEAD_APPT.has(String(e.appointmentStatus ?? "").toLowerCase()));
}

/* The account's survey + nurture workflow ids, cached a few minutes per account. */
const wfCache = new Map<string, { at: number; wfs: { id: string; name: string }[] }>();
async function workflowsToLeave(tok: string, locationId: string): Promise<{ id: string; name: string }[] | null> {
  const hit = wfCache.get(locationId);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.wfs;
  try {
    const j = await getJson<{ workflows?: { id?: string; name?: string; status?: string }[] }>(`${GHL}/workflows/?locationId=${encodeURIComponent(locationId)}`, H(tok));
    if (!j) return null;
    const wfs = (j.workflows ?? [])
      .filter((w) => w.id && w.status === "published" && !/preview/i.test(String(w.name ?? "")) && LEAVE_WORKFLOWS.some((re) => re.test(String(w.name ?? ""))))
      .map((w) => ({ id: String(w.id), name: String(w.name) }));
    wfCache.set(locationId, { at: Date.now(), wfs });
    return wfs;
  } catch {
    return null;
  }
}

async function editTag(tok: string, contactId: string, method: "POST" | "DELETE", tag: string): Promise<string | null> {
  try {
    const r = await fetch(`${GHL}/contacts/${encodeURIComponent(contactId)}/tags`, {
      method, headers: H(tok), body: JSON.stringify({ tags: [tag] }), signal: AbortSignal.timeout(10_000),
    });
    return r.ok ? null : `tag ${method} HTTP ${r.status}`;
  } catch (e) {
    return `tag ${method}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

const hasTag = (c: GhlContact | null, tag: string) => (c?.tags ?? []).some((t) => String(t).toLowerCase() === tag.toLowerCase());
const failedRestart = (a: Record<string, unknown> | null) => String(a?.repeatRestart ?? "").startsWith("failed");

/** Never throws. */
export async function restartSurveyForRepeat(svc: Svc, inp: RepeatRestartInput): Promise<RepeatRestart> {
  try {
    const cfg = await getRepeatRestartSettings(svc);
    if (!inp.ignoreSwitch && (!cfg.enabled || (Array.isArray(cfg.locations) && !cfg.locations.includes(inp.locationId)))) {
      return { result: "off" };
    }
    const now = Date.now();

    // 1. Her forms in this account from BEFORE this one (same GHL contact = same phone).
    let q = svc
      .from("onebox_leads")
      .select("id, created_at, ghl_status, paid_at, ghl_appointment_id, answers")
      .eq("location_id", inp.locationId)
      .eq("ghl_contact_id", inp.contactId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (inp.newLeadId != null) q = q.lt("id", inp.newLeadId);
    const { data: rows, error } = await q;
    if (error) return { result: "failed", reason: `earlier forms: ${error.message}` };
    const earlier = (rows ?? []) as { id: number; created_at: string; ghl_status: string | null; paid_at: string | null; ghl_appointment_id: string | null; answers: Record<string, unknown> | null }[];
    if (earlier.some((r) => PAID_STATUS.has(String(r.ghl_status ?? "")) || r.paid_at || r.ghl_appointment_id)) {
      return { result: "skipped", reason: "paid_or_booked", prevAt: earlier[0]?.created_at };
    }
    const qualified = earlier.filter((r) => !r.answers?.disqualified);
    // A qualified form inside the gap: same visit, or it already did the restart (unless that one failed).
    if (qualified.some((r) => now - Date.parse(r.created_at) < cfg.minGapHours * 3600_000 && !failedRestart(r.answers))) {
      return { result: "skipped", reason: "recent_form", prevAt: qualified[0].created_at };
    }
    const prevRow = qualified.find((r) => now - Date.parse(r.created_at) >= cfg.minGapHours * 3600_000);

    // 2. Her contact in GHL right now.
    const tk = await getAppLocationToken(inp.locationId);
    if (!tk.token) return { result: "failed", reason: `token: ${tk.error ?? "none"}`, prevAt: prevRow?.created_at };
    const tok = tk.token;
    const c = await readContact(tok, inp.contactId);
    if (!c) return { result: "failed", reason: "contact_unreadable", prevAt: prevRow?.created_at };
    // An earlier visit that stopped at the phone step left the tag but no row: the tag
    // plus a text to her from before the gap shows it.
    const times = await messageTimes(tok, inp.locationId, inp.contactId);
    if (times == null) return { result: "failed", reason: "messages_unreadable", prevAt: prevRow?.created_at };
    const ghlRepeat = !prevRow && hasTag(c, inp.surveyTag) && times.oldestOut > 0 && now - times.oldestOut >= cfg.minGapHours * 3600_000;
    if (!prevRow && !ghlRepeat) return { result: "not_repeat" };
    const prevAt = prevRow?.created_at ?? "ghl";

    const sms = String(c.dndSettings?.SMS?.status ?? "").toLowerCase();
    if (c.dnd === true || (sms && sms !== "inactive")) return { result: "skipped", reason: "dnd", prevAt };
    const tagsLower = (c.tags ?? []).map((t) => String(t).toLowerCase());
    if (PAID_TAGS.some((t) => tagsLower.includes(t))) return { result: "skipped", reason: "paid_tag", prevAt };
    if (BOOKED_TAGS.some((t) => tagsLower.includes(t))) return { result: "skipped", reason: "booked_tag", prevAt };
    const appt = await hasLiveAppointment(tok, inp.contactId);
    if (appt == null) return { result: "failed", reason: "appointments_unreadable", prevAt };
    if (appt) return { result: "skipped", reason: "has_appointment", prevAt };

    // 3. Not mid-chat: no real message either way in the quiet window.
    const quietH = inp.quietHoursOverride ?? cfg.quietHours;
    if (times.newest && now - times.newest < quietH * 3600_000) return { result: "skipped", reason: "recent_chat", prevAt };

    const wfs = await workflowsToLeave(tok, inp.locationId);
    if (wfs == null) return { result: "failed", reason: "workflows_unreadable", prevAt };
    if (inp.dryRun) return { result: "would_restart", prevAt, left: wfs.map((w) => w.name) };

    // 4. Out of the old run, tag off, tag on → GHL starts the survey from its first step.
    const left: string[] = [];
    for (const w of wfs) {
      const ok = await fetch(`${GHL}/contacts/${encodeURIComponent(inp.contactId)}/workflow/${encodeURIComponent(w.id)}`, {
        method: "DELETE", headers: H(tok), signal: AbortSignal.timeout(10_000),
      }).then((r) => r.ok).catch(() => false);
      if (ok) left.push(w.name);
    }
    let lastErr = "";
    if (hasTag(c, inp.surveyTag)) {
      // Even when this call errors, GHL may have removed it: always go on to put it back.
      lastErr = (await editTag(tok, inp.contactId, "DELETE", inp.surveyTag)) ?? "";
      await sleep(1500);
    }
    for (let i = 0; i < 3; i++) {
      const add = await editTag(tok, inp.contactId, "POST", inp.surveyTag);
      if (add) lastErr = add;
      await sleep(1000 * (i + 1));
      if (hasTag(await readContact(tok, inp.contactId), inp.surveyTag)) return { result: "restarted", prevAt, left };
    }
    // Left WITHOUT the tag would hide her from every survey check: say it loudly.
    console.error("[repeat-restart] survey tag not back on contact", inp.locationId, inp.contactId, lastErr);
    return { result: "failed", reason: `tag_not_back${lastErr ? `: ${lastErr}` : ""}`, prevAt, left };
  } catch (e) {
    return { result: "failed", reason: e instanceof Error ? e.message.slice(0, 160) : "error" };
  }
}

/* Run it for a just-saved lead row and keep the outcome on the row
   (answers.repeatRestart = "result[:reason]|time"). The row's answers are
   read again right before the write, so the pick-time stage's depAsk keys,
   written while this ran, are kept. Never throws. */
export async function runRepeatRestartForLead(svc: Svc, inp: Omit<RepeatRestartInput, "dryRun" | "ignoreSwitch" | "quietHoursOverride"> & { newLeadId: number }): Promise<RepeatRestart> {
  const rr = await restartSurveyForRepeat(svc, inp);
  if (rr.result === "off" || rr.result === "not_repeat") return rr;
  if (rr.result === "failed") console.error("[repeat-restart] failed:", inp.locationId, inp.contactId, rr.reason);
  try {
    const { data } = await svc.from("onebox_leads").select("answers").eq("id", inp.newLeadId).maybeSingle();
    const answers = (data?.answers as Record<string, unknown> | null) ?? {};
    const value = `${rr.result}${rr.reason ? `:${rr.reason}` : ""}|${new Date().toISOString()}`;
    const { error } = await svc.from("onebox_leads").update({ answers: { ...answers, repeatRestart: value } }).eq("id", inp.newLeadId);
    if (error) console.error("[repeat-restart] save failed:", error.message);
  } catch (e) {
    console.error("[repeat-restart] save failed:", e instanceof Error ? e.message : e);
  }
  return rr;
}
