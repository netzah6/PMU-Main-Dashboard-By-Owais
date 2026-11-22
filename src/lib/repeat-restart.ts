import type { SupabaseClient } from "@supabase/supabase-js";
import { getAppLocationToken } from "@/lib/ghl-app";

/* Repeat sign-ups (owner, 11/22/2026). A lead who fills in the one-box form
   again weeks later already has the "onebox-survey" tag from her first visit.
   Our push adds the tag again, GHL sees nothing new, and the survey workflow
   (trigger: Contact Tag added "onebox-survey") never starts — so she gets no
   text at all (proven in GHL audit + execution logs for 3 leads, 11/22).
   Fix: on a real repeat, take the tag off and put it back, so the normal
   survey starts again. The survey itself turns the AI off at its start and
   back on at her first reply (owner: the AI should come back on for a new
   request).

   Only for a real repeat:
   - an earlier QUALIFIED form for this contact, at least `minGapHours` old
     (a double submit in one visit is not a repeat; a fill within the gap
     already had its own chance to restart),
   - she never paid or booked (any earlier row, or a paid/booked tag in GHL),
   - not on SMS DND,
   - no text in or out in the last `quietHours` (she is not mid-chat).
   Ships OFF: app_settings "repeat_restart" {enabled, locations}. */

type Svc = SupabaseClient;
const GHL = "https://services.leadconnectorhq.com";
export const REPEAT_RESTART_KEY = "repeat_restart";
const PAID_STATUS = new Set(["booked", "paid", "paid-not-booked", "paid-followup"]);
const PAID_TAGS = ["fanbasis buyer", "deposit collected"];
// "booked" = the AI booked her a time (CloseBot); "onebox-booked" = our paid booking.
const BOOKED_TAGS = ["booked", "onebox-booked"];

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
  | "not_repeat" // first qualified form for this contact
  | "skipped" // a repeat, but a rule says leave her alone (see reason)
  | "would_restart" // dry run: every rule passed
  | "restarted" // tag taken off and back on, confirmed on the contact
  | "failed"; // something could not be read or written (see reason)

export interface RepeatRestart {
  result: RepeatRestartResult;
  reason?: string;
  /** her newest earlier qualified form */
  prevAt?: string;
}

export interface RepeatRestartInput {
  locationId: string;
  contactId: string;
  /** the onebox_leads row of THIS form (left out of the "earlier" look-up) */
  newLeadId: number | null;
  surveyTag: string;
  /** read and decide only — never touches the tag */
  dryRun?: boolean;
  /** tests only: run even when the switch is off for this account */
  ignoreSwitch?: boolean;
  /** tests only: replace the quiet window */
  quietHoursOverride?: number;
}

const H = (tok: string) => ({ Authorization: `Bearer ${tok}`, Version: "2021-07-28", "Content-Type": "application/json", Accept: "application/json" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface GhlContact { tags?: string[]; dnd?: boolean; dndSettings?: Record<string, { status?: string } | undefined> }

async function readContact(tok: string, contactId: string): Promise<GhlContact | null> {
  try {
    const r = await fetch(`${GHL}/contacts/${encodeURIComponent(contactId)}`, { headers: H(tok), signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { contact?: GhlContact };
    return j.contact ?? null;
  } catch {
    return null;
  }
}

/** Newest real text/call/email time on her threads (ms), 0 when none; null = could not read. */
async function lastMessageMs(tok: string, locationId: string, contactId: string): Promise<number | null> {
  try {
    const hdr = { ...H(tok), Version: "2021-04-15" };
    const sr = await fetch(`${GHL}/conversations/search?locationId=${encodeURIComponent(locationId)}&contactId=${encodeURIComponent(contactId)}`, { headers: hdr, signal: AbortSignal.timeout(10_000) });
    if (!sr.ok) return null;
    const convs = ((await sr.json()) as { conversations?: { id: string }[] }).conversations ?? [];
    let newest = 0;
    for (const cv of convs.slice(0, 3)) {
      const mr = await fetch(`${GHL}/conversations/${encodeURIComponent(cv.id)}/messages?limit=20`, { headers: hdr, signal: AbortSignal.timeout(10_000) });
      if (!mr.ok) return null;
      const msgs = ((await mr.json()) as { messages?: { messages?: { dateAdded?: string; messageType?: string }[] } }).messages?.messages ?? [];
      for (const m of msgs) {
        // Activity rows (opportunity created, appointment changed …) are not a chat.
        if (String(m.messageType ?? "").startsWith("TYPE_ACTIVITY")) continue;
        const t = Date.parse(String(m.dateAdded ?? ""));
        if (t > newest) newest = t;
      }
    }
    return newest;
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

/** Never throws. */
export async function restartSurveyForRepeat(svc: Svc, inp: RepeatRestartInput): Promise<RepeatRestart> {
  try {
    const cfg = await getRepeatRestartSettings(svc);
    if (!inp.ignoreSwitch && (!cfg.enabled || (Array.isArray(cfg.locations) && !cfg.locations.includes(inp.locationId)))) {
      return { result: "off" };
    }
    const now = Date.now();

    // 1. Her earlier forms in this account (same GHL contact = same phone).
    let q = svc
      .from("onebox_leads")
      .select("id, created_at, ghl_status, paid_at, ghl_appointment_id, answers")
      .eq("location_id", inp.locationId)
      .eq("ghl_contact_id", inp.contactId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (inp.newLeadId != null) q = q.neq("id", inp.newLeadId);
    const { data: rows, error } = await q;
    if (error) return { result: "failed", reason: `earlier forms: ${error.message}` };
    const earlier = (rows ?? []) as { id: number; created_at: string; ghl_status: string | null; paid_at: string | null; ghl_appointment_id: string | null; answers: Record<string, unknown> | null }[];
    const qualified = earlier.filter((r) => !r.answers?.disqualified);
    // Only her earlier QUALIFIED forms ever got the tag; none = this is her first real one.
    if (!qualified.length) return { result: "not_repeat" };
    const prevAt = qualified[0].created_at;
    if (earlier.some((r) => PAID_STATUS.has(String(r.ghl_status ?? "")) || r.paid_at || r.ghl_appointment_id)) {
      return { result: "skipped", reason: "paid_or_booked", prevAt };
    }
    // Any earlier form (qualified or not) inside the gap = same visit / just handled.
    if (now - Date.parse(earlier[0].created_at) < cfg.minGapHours * 3600_000) {
      return { result: "skipped", reason: "recent_form", prevAt };
    }

    // 2. Her contact in GHL right now.
    const tk = await getAppLocationToken(inp.locationId);
    if (!tk.token) return { result: "failed", reason: `token: ${tk.error ?? "none"}`, prevAt };
    const tok = tk.token;
    const c = await readContact(tok, inp.contactId);
    if (!c) return { result: "failed", reason: "contact_unreadable", prevAt };
    if (c.dnd === true || c.dndSettings?.SMS?.status === "active") return { result: "skipped", reason: "dnd", prevAt };
    const tagsLower = (c.tags ?? []).map((t) => String(t).toLowerCase());
    if (PAID_TAGS.some((t) => tagsLower.includes(t))) return { result: "skipped", reason: "paid_tag", prevAt };
    if (BOOKED_TAGS.some((t) => tagsLower.includes(t))) return { result: "skipped", reason: "booked_tag", prevAt };

    // 3. Not mid-chat: no real message either way in the quiet window.
    const quietH = inp.quietHoursOverride ?? cfg.quietHours;
    const lastMs = await lastMessageMs(tok, inp.locationId, inp.contactId);
    if (lastMs == null) return { result: "failed", reason: "messages_unreadable", prevAt };
    if (lastMs && now - lastMs < quietH * 3600_000) return { result: "skipped", reason: "recent_chat", prevAt };

    if (inp.dryRun) return { result: "would_restart", prevAt };

    // 4. Off, then back on → GHL records a new "tag added" and the survey starts.
    if (hasTag(c, inp.surveyTag)) {
      const del = await editTag(tok, inp.contactId, "DELETE", inp.surveyTag);
      if (del) return { result: "failed", reason: del, prevAt };
      await sleep(1500);
    }
    let lastErr = "";
    for (let i = 0; i < 3; i++) {
      const add = await editTag(tok, inp.contactId, "POST", inp.surveyTag);
      if (add) lastErr = add;
      await sleep(1000 * (i + 1));
      if (hasTag(await readContact(tok, inp.contactId), inp.surveyTag)) return { result: "restarted", prevAt };
    }
    // Left WITHOUT the tag would hide her from every survey check: say it loudly.
    console.error("[repeat-restart] survey tag not back on contact", inp.locationId, inp.contactId, lastErr);
    return { result: "failed", reason: `tag_not_back${lastErr ? `: ${lastErr}` : ""}`, prevAt };
  } catch (e) {
    return { result: "failed", reason: e instanceof Error ? e.message.slice(0, 160) : "error" };
  }
}
