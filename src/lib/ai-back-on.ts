import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken } from "@/lib/ghl-app";
import { locationTimezone } from "@/lib/onebox";
import { firstName, hasPaidTag, leadTimezone, nextDaytime, readContact } from "@/lib/pick-email";
import { AUTOMATED_SOURCES, keepAiOn, lowerTags, smsSegments, type AiRestore } from "@/lib/pick-sms";
import { CLIENTS_KEY, loadDirectory, type CbClients } from "@/lib/closebot-coverage";
import { fileAlert } from "@/lib/alerts";

type Svc = ReturnType<typeof createServiceClient>;

/* AI back on after the artist's hand text (owner, approved 11/22/2026 and
   the check-in text 11/26/2026).

   THE LEAK: when an artist texts a lead by hand, CloseBot's "Bot Auto
   Shutoff" tags her "ai off" within about a minute, so the two never talk
   over each other. That part is on purpose. But nothing ever turns the AI
   back on: if the artist then forgets her, nobody texts her again.

   PROVEN on the Demo (11/26/2026): only taking "ai off" off is NOT enough.
   While the AI was off, CloseBot dropped the follow-up it had planned
   (followUpTime → null) and it sent nothing in the 45 minutes after
   "ai off" came off. CloseBot only talks again when she texts. So the fix
   also sends her ONE short check-in; her reply goes to the AI.

   Who gets the check-in (every check, live in GHL, at the moment of sending):
   - a Live V3 studio on Clients Master whose CloseBot is ON in the daily
     CloseBot check (else nobody would answer her reply), except the studios
     the owner keeps out of all changes (SKIP_LOCATIONS);
   - she has "ai off" and "(v3)"; no paid tag, no goodbye / declining /
     stop / opt-out tag; SMS do-not-disturb off;
   - the AI (CloseBot) talked to her, and after that a PERSON took over: an
     outbound text with no app name that no automation sent, or an outbound
     call (GHL's export names every app's message, so a text with no app
     name was typed by a person — same rule as src/lib/pick-sms.ts). A call
     she ANSWERED for a minute or more → skip (we can't know what they agreed);
   - that last person touch is 48 hours to 7 days ago, and she has sent
     NOTHING since (any channel, any inbound) — so she has no unanswered
     message the AI would answer days late the moment it comes back;
   - nobody texted her at all (any outbound) in the last 48 hours;
   - her opportunity is open and not in a stage where the artist stopped
     or finished (Call Later, Declining, booked, deposit, session done,
     5 stars, Reactivation — the Reactivation texts handle her there);
   - no appointment in GHL (only cancelled ones and expired AI holds,
     status "invalid", don't count);
   - a model reads the thread and finds no sign that she booked or paid
     somewhere else, said no, asked to wait, or that the artist moved her
     to a call / DM / in person. When unsure → no text;
   - ONE check-in per lead, ever; daytime for her (10 AM – 6 PM her time);
     a daily cap per studio.

   The leads are found LIVE in GHL each run (contacts tagged "ai off" and
   updated in the last 8 days, per studio) — the synced copy of tags in
   Supabase stops updating about a day after a lead comes in, so it misses
   most takeovers (review 11/26/2026).

   What happens: the check-in goes out from the studio's own number; then
   keepAiOn (pick-sms.ts) takes "ai off" off and puts "ai on" + "(v3)" on,
   and keeps it that way through CloseBot's shutoff, which fires again on
   our own text. If she answers, CloseBot answers her. If the AI can't be
   switched back on, or she replied while it was switching, an alert goes
   to the Alerts tab so a person answers her.

   Vercel stops the run at 300 s and keepAiOn needs up to ~2 min after each
   text, so no text starts after SEND_DEADLINE_MS; the "sent" row is written
   right after the text, before the AI step. A lease in app_settings stops
   two runs from overlapping (Vercel may deliver a cron twice).

   Ships OFF (app_settings "ai_back_on"). ?dry=1 on the cron shows who WOULD
   get the text and writes nothing. */

export const AI_BACK_ON_KEY = "ai_back_on";
const TABLE = "ai_back_on_people";
const GHL = "https://services.leadconnectorhq.com";

const QUIET_MS = 48 * 3600_000;      // owner 11/22: the AI comes back after 48 hours
const MAX_AGE_MS = 7 * 86400_000;    // takeovers from the last week only (older leads are win-back's job)
const MEMORY_MS = 30 * 86400_000;    // how long a model "no" / a failed send is remembered
const SMS_DAY = { from: 10, to: 18, resume: 10 }; // her clock
const PER_STUDIO_DAY = 15;
const MAX_PER_RUN = 25;               // texts per run (each needs ~1.5 min of AI-on watching)
const CONCURRENCY = 4;
const MODEL = process.env.AI_BACK_ON_MODEL || "claude-opus-5-5";
const TALK_SECONDS = 60;              // an answered call this long = they talked
const ROUTE_LIMIT_MS = 300_000;       // the route's maxDuration
const RESTORE_MS = 135_000;           // keepAiOn: 80 s watch + 45 s hard stop + the last read
const SEND_DEADLINE_MS = ROUTE_LIMIT_MS - RESTORE_MS - 20_000; // no text starts after this
const CB_FRESH_MS = 3 * 86400_000;    // the daily CloseBot check must be this fresh
const LOCK_KEY = "ai_back_on_lock";
const LOCK_MS = ROUTE_LIMIT_MS + 10_000;

/* Studios the owner keeps out of every change (11/22 + 11/26/2026). Since
   11/26 the third one that used to be here is included like everyone. */
export const SKIP_LOCATIONS = new Set(["dYwyxDQHMeVYzdEkste0", "bfrgIDvy4mFHwaQ2TOOq"]);

/* THE TEXT — approved by the owner 11/26/2026:
   "Hi Sarah, still thinking about your Eyebrows? Happy to answer any questions 💜"
   {first} = her clean first name ("there" when junk/empty); {service} = the
   area(s) she picked on the survey, as the Reactivation texts show them.
   No area on file → the same text without it. */
export const AI_BACK_ON_TEXT = "Hi {first}, still thinking about your {service}? Happy to answer any questions 💜";
export const AI_BACK_ON_TEXT_NO_SERVICE = "Hi {first}, still thinking about it? Happy to answer any questions 💜";
const AREA_FIELD_KEY = "contact.which_areas_would_you_like_treated";
const CHECK_IN_SENT = /still thinking about (your .{1,60}|it)\? Happy to answer any questions/i;

export function checkInText(first: string, service: string): string {
  const t = service ? AI_BACK_ON_TEXT : AI_BACK_ON_TEXT_NO_SERVICE;
  return t.replace("{first}", first || "there").replace("{service}", service);
}

/** "Eyebrows" / ["Eyebrows","Lips"] → "Eyebrows and Lips". Junk or too long → "". */
export function areaWords(v: unknown): string {
  const parts = (Array.isArray(v) ? v : String(v ?? "").split(/\s*,\s*/))
    .map((s) => String(s ?? "").replace(/[^\p{L}\p{N} &'’/-]/gu, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (!parts.length) return "";
  const s = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return s.length <= 40 ? s : "";
}

// ─── Switch ─────────────────────────────────────────────────────────────────
export type AiBackOnSettings = { enabled: boolean; startAt: string | null; updatedBy?: string | null };
const DEFAULTS: AiBackOnSettings = { enabled: false, startAt: null };

export async function getAiBackOnSettings(svc: Svc): Promise<AiBackOnSettings> {
  const { data } = await svc.from("app_settings").select("value").eq("key", AI_BACK_ON_KEY).maybeSingle();
  return { ...DEFAULTS, ...((data?.value as Partial<AiBackOnSettings> | null) ?? {}) };
}

const isMissingTable = (e: { code?: string; message?: string } | null | undefined) =>
  !!e && (e.code === "PGRST205" || e.code === "42P01" || /could not find the table|does not exist/i.test(String(e.message ?? "")));

export async function setAiBackOnEnabled(svc: Svc, enabled: boolean, by: string): Promise<AiBackOnSettings> {
  const prev = await getAiBackOnSettings(svc);
  const next: AiBackOnSettings = { ...prev, enabled, updatedBy: by };
  if (enabled) {
    const probe = await svc.from(TABLE).select("id").limit(1);
    if (isMissingTable(probe.error)) throw new Error(`The ${TABLE} table isn't created yet (supabase/ai-back-on.sql) — it stays off.`);
    if (probe.error) throw new Error(probe.error.message);
    if (!prev.enabled) next.startAt = new Date().toISOString();
  }
  const { error } = await svc.from("app_settings").upsert({ key: AI_BACK_ON_KEY, value: next, updated_by: by, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
  return next;
}

// ─── Reading one lead ───────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** fetch that waits and retries when GHL says "too many requests" (429) or hiccups (5xx). Null = no answer. */
async function ghlGet(url: string, headers: Record<string, string>): Promise<Response | null> {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (r && r.status !== 429 && r.status < 500) return r;
    if (i < 3) await sleep(2_000 * (i + 1) + Math.floor(Math.random() * 1_000));
    else return r;
  }
  return null;
}
type Msg = { id: string; at: number; dir: "inbound" | "outbound" | ""; type: string; source: string; app: string; body: string; callSecs: number; callStatus: string };

const NOT_A_MESSAGE = /ACTIVITY|COMMENT/i;
const isCall = (m: Msg) => /CALL/i.test(m.type);
const isEmail = (m: Msg) => /EMAIL/i.test(m.type);
const byCloseBot = (m: Msg) => m.dir === "outbound" && /closebot/i.test(m.app);
/** A person typed it (or called): outbound, no app name, not an automation. Emails never count. */
export const byPerson = (m: Msg) =>
  m.dir === "outbound" && !isEmail(m) && (isCall(m) || (!m.app && !AUTOMATED_SOURCES.includes(m.source)));

/** Her whole message history across channels, newest first (export, up to 5 pages). Null = can't read. */
async function history(tok: string, locationId: string, contactId: string, stopBeforeMs: number): Promise<{ msgs: Msg[]; complete: boolean } | null> {
  const H = { Authorization: `Bearer ${tok}`, Version: "2021-04-15", Accept: "application/json" };
  const out: Msg[] = [];
  let cursor = "";
  for (let page = 0; page < 5; page++) {
    const url = `${GHL}/conversations/messages/export?locationId=${encodeURIComponent(locationId)}&contactId=${encodeURIComponent(contactId)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r = await ghlGet(url, H);
    if (!r || !r.ok) return null;
    const j = (await r.json().catch(() => null)) as { messages?: Record<string, unknown>[]; nextCursor?: string | null } | null;
    if (!j) return null;
    const raw = j.messages ?? [];
    for (const m of raw) {
      const type = String(m.messageType ?? "");
      if (NOT_A_MESSAGE.test(type)) continue;
      const at = Date.parse(String(m.dateAdded ?? ""));
      if (!Number.isFinite(at)) continue;
      const dir = String(m.direction ?? "").toLowerCase();
      const meta = (m.meta ?? {}) as { marketplace?: { appName?: string }; call?: { duration?: number; status?: string } };
      out.push({
        id: String(m.id ?? ""), at, dir: dir === "inbound" || dir === "outbound" ? dir : "", type,
        source: String(m.source ?? "").toLowerCase(),
        app: String(meta.marketplace?.appName ?? ""),
        body: String(m.body ?? "").trim(),
        callSecs: Number(meta.call?.duration ?? 0) || 0,
        callStatus: String(meta.call?.status ?? m.status ?? "").toLowerCase(),
      });
    }
    const oldest = Math.min(...raw.map((m) => Date.parse(String(m.dateAdded ?? ""))).filter(Number.isFinite));
    if (!raw.length || !j.nextCursor || oldest < stopBeforeMs) return { msgs: out.sort((a, b) => b.at - a.at), complete: true };
    cursor = String(j.nextCursor);
  }
  return { msgs: out.sort((a, b) => b.at - a.at), complete: false };
}

/* Stages where the artist stopped, finished, or another flow has her (names seen
   across all studios' pipelines 11/26/2026): Call Later / contact later,
   Declining, DND, Deposit Reminder + Deposit Collected, Session Done,
   5 Stars, booked / appointment / consultation / no-show, Reactivation (its
   own texts handle her), touch-ups and past clients, cancelled, contract,
   paid. Normal ones pass: Very Hot Lead, Text, 2nd/3rd Attempt, Warm/Hot. */
const STOP_STAGE = /later|declin|dnd|do not|deposit|session|complete|closed|star|book|appointment|confirm|show|reactiv|touch|retention|annual|training|student|cancel|contract|lost|not interested|\bwon\b|paid|payment|consult|video/i;
const STOP_TAGS = ["goodbye sent", "declining", "stop nurturing", "opted out", "opt out", "opt-out", "dnd", "do not contact", "wrong number", "not interested", "unsubscribed"];

type Pipes = Map<string, Map<string, string>>; // location → stage id → name
async function stageNames(tok: string, locationId: string, cache: Pipes): Promise<Map<string, string> | null> {
  if (cache.has(locationId)) return cache.get(locationId)!;
  const r = await ghlGet(`${GHL}/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`, { Authorization: `Bearer ${tok}`, Version: "2021-07-28", Accept: "application/json" });
  if (!r || !r.ok) return null;
  const names = new Map<string, string>();
  for (const pl of (((await r.json()) as { pipelines?: { stages?: { id: string; name: string }[] }[] }).pipelines ?? [])) for (const s of pl.stages ?? []) names.set(s.id, s.name);
  cache.set(locationId, names);
  return names;
}

/** Her opportunities: "ok" when every one is open and in a normal stage. */
async function oppCheck(tok: string, locationId: string, contactId: string, pipes: Pipes): Promise<{ ok: true } | { ok: false; why: string; error?: boolean }> {
  const r = await ghlGet(`${GHL}/opportunities/search?location_id=${encodeURIComponent(locationId)}&contact_id=${encodeURIComponent(contactId)}`, { Authorization: `Bearer ${tok}`, Version: "2021-07-28", Accept: "application/json" });
  if (!r || !r.ok) return { ok: false, why: `opportunities HTTP ${r?.status ?? 0}`, error: true };
  const opps = (((await r.json()) as { opportunities?: { pipelineStageId?: string; status?: string }[] }).opportunities ?? []);
  if (!opps.length) return { ok: true };
  const names = await stageNames(tok, locationId, pipes);
  if (!names) return { ok: false, why: "pipelines unreadable", error: true };
  for (const o of opps) {
    const status = String(o.status ?? "open").toLowerCase();
    if (status !== "open") return { ok: false, why: `opportunity ${status}` };
    const stage = names.get(String(o.pipelineStageId ?? "")) ?? "";
    if (STOP_STAGE.test(stage)) return { ok: false, why: `stage: ${stage}` };
  }
  return { ok: true };
}

/** Any appointment that isn't cancelled or an expired AI hold ("invalid") → she booked. */
async function apptCheck(tok: string, contactId: string): Promise<{ ok: true } | { ok: false; why: string; error?: boolean }> {
  const r = await ghlGet(`${GHL}/contacts/${encodeURIComponent(contactId)}/appointments`, { Authorization: `Bearer ${tok}`, Version: "2021-07-28", Accept: "application/json" });
  if (!r || !r.ok) return { ok: false, why: `appointments HTTP ${r?.status ?? 0}`, error: true };
  const ev = (((await r.json()) as { events?: { appointmentStatus?: string; deleted?: boolean }[] }).events ?? []);
  const real = ev.filter((e) => !e.deleted && !["cancelled", "canceled", "invalid"].includes(String(e.appointmentStatus ?? "").toLowerCase()));
  return real.length ? { ok: false, why: `appointment (${String(real[0].appointmentStatus ?? "?")})` } : { ok: true };
}

type FieldIds = Map<string, string | null>; // location → id of the "which areas" field
async function areaFieldId(tok: string, locationId: string, cache: FieldIds): Promise<string | null> {
  if (cache.has(locationId)) return cache.get(locationId)!;
  const r = await ghlGet(`${GHL}/locations/${encodeURIComponent(locationId)}/customFields`, { Authorization: `Bearer ${tok}`, Version: "2021-07-28", Accept: "application/json" });
  const id = r && r.ok
    ? (((await r.json()) as { customFields?: { id: string; fieldKey?: string }[] }).customFields ?? []).find((f) => f.fieldKey === AREA_FIELD_KEY)?.id ?? null
    : null;
  cache.set(locationId, id);
  return id;
}

// ─── The model's look at the thread ─────────────────────────────────────────
const SYSTEM = `You read a text-message thread between a permanent-makeup (PMU) studio and a lead. The studio side has three kinds of senders, labeled: AI (the studio's AI assistant), ARTIST (the studio owner typing by hand or calling), AUTO (automated messages).
The artist took the conversation over from the AI, and then the lead went quiet for 2+ days. We are about to send her ONE gentle check-in from the studio: "Hi <name>, still thinking about your <service>? Happy to answer any questions 💜". If she answers, the AI takes the conversation back.
Decide if that check-in makes sense now. Answer send=false if there is ANY sign that:
- she booked, scheduled or agreed on a date/time (in any form, even outside the system), or paid / sent a deposit;
- she said no, not interested, stop, wrong number, too expensive and closed it, or was rude / complained / threatened;
- she asked to wait or said she will reach out later (e.g. after a trip, a date, payday) and that time may not have come;
- the artist moved the conversation elsewhere (phone call, Instagram/Facebook DM, in person) or said she will follow up herself;
- the artist's last message closed the conversation (goodbye, "no problem, take care", "I'll leave it here");
- she is an existing client (aftercare, touch-up after a session, a past appointment);
- the thread is confusing, or the check-in would sound strange or repetitive after the last messages.
Answer send=true only when she is a prospective client, the artist or AI asked or offered something, and she simply went quiet.
When unsure → send=false.
Reply with JSON only: {"send": true|false, "why": "<at most 12 plain words>"}`;

function threadText(msgs: Msg[]): string {
  return [...msgs].reverse().slice(-40).map((m) => {
    const when = new Date(m.at).toISOString().slice(5, 16).replace("T", " ");
    const who = m.dir === "inbound" ? "LEAD" : byCloseBot(m) ? "AI" : byPerson(m) ? "ARTIST" : "AUTO";
    const body = isCall(m)
      ? (m.callSecs >= TALK_SECONDS ? `(phone call, they talked ${Math.round(m.callSecs / 60)} min)` : `(phone call, no real talk${m.callStatus ? `: ${m.callStatus}` : ""})`)
      : (m.body || "(no text)").replace(/\s+/g, " ").slice(0, 400);
    return `[${when}] ${who}: ${body}`;
  }).join("\n");
}

async function modelSays(client: Anthropic, msgs: Msg[]): Promise<{ send: boolean; why: string } | null> {
  try {
    const res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: SYSTEM,
      messages: [{ role: "user", content: `Thread (oldest first):\n${threadText(msgs)}\n\nShould we send the check-in now? JSON only.` }],
      betas: ["server-side-fallback-2026-07-01"],
      ...({ fallbacks: "default", output_config: { effort: "low" } } as Record<string, unknown>),
    });
    if (res.stop_reason === "refusal") return null;
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]) as { send?: unknown; why?: unknown };
    if (typeof j.send !== "boolean") return null;
    return { send: j.send, why: String(j.why ?? "").slice(0, 120) };
  } catch {
    return null;
  }
}

// ─── Deciding one lead ──────────────────────────────────────────────────────
export type Decision =
  | { kind: "send"; text: string; first: string; service: string; touchAt: number; touchBy: "text" | "call"; tz: string; lastMessageId: string; segments: number }
  | { kind: "skip"; why: string; lastMessageId?: string; modelNo?: boolean }
  | { kind: "later"; why: string; at?: string }
  | { kind: "error"; why: string };

type Judge = (msgs: Msg[]) => Promise<{ send: boolean; why: string } | null>;
type Ctx = { tok: string; locTz: string; pipes: Pipes; fields: FieldIds; client: Anthropic | null; judge?: Judge; now: number; quietMs: number; maxAgeMs: number; modelNo: Map<string, string>; guardSince?: number; anyHour?: boolean };

export async function decide(ctx: Ctx, locationId: string, contactId: string): Promise<Decision> {
  const { tok, now } = ctx;
  // 1. Tags + do-not-disturb (cheapest).
  let cr: Awaited<ReturnType<typeof readContact>> = { kind: "error", why: "not read" };
  for (let i = 0; i < 4; i++) {
    cr = await readContact(tok, contactId).catch((e) => ({ kind: "error" as const, why: String(e) }));
    if (cr.kind !== "error" || !/ 429| 5\d\d|fetch failed|timeout/i.test(cr.why) || i === 3) break;
    await sleep(2_000 * (i + 1) + Math.floor(Math.random() * 1_000));
  }
  if (cr.kind === "gone") return { kind: "skip", why: "contact deleted" };
  if (cr.kind === "error") return { kind: "error", why: cr.why };
  const c = cr.c;
  const tags = lowerTags(c);
  if (!tags.includes("ai off")) return { kind: "skip", why: "AI is not off" };
  if (!tags.includes("(v3)")) return { kind: "skip", why: "not a V3 lead" };
  if (hasPaidTag(c)) return { kind: "skip", why: "paid" };
  const stopTag = tags.find((t) => STOP_TAGS.includes(t));
  if (stopTag) return { kind: "skip", why: `tag: ${stopTag}` };
  // Same rule as repeat-restart / win-back: a STOP reply is saved as SMS status "permanent", not "active".
  const smsSt = String(((c.dndSettings as Record<string, { status?: string } | undefined> | undefined)?.SMS?.status) ?? "").toLowerCase();
  const dnd = c.dnd === true || (!!smsSt && smsSt !== "inactive");
  if (dnd) return { kind: "skip", why: "do not disturb" };
  if (!String(c.phone ?? "").trim()) return { kind: "skip", why: "no phone" };

  // 2. Her messages.
  const h = await history(tok, locationId, contactId, now - ctx.maxAgeMs - 30 * 86400_000);
  if (!h) return { kind: "error", why: "messages unreadable" };
  const msgs = h.msgs;
  if (!msgs.length) return { kind: "skip", why: "no messages" };
  const lastPerson = msgs.find(byPerson);
  if (!lastPerson) return { kind: "skip", why: "no artist text or call" };
  const touchAge = now - lastPerson.at;
  if (touchAge < ctx.quietMs) return { kind: "later", why: "artist touch under 48 h ago" };
  if (touchAge > ctx.maxAgeMs) return { kind: "skip", why: "artist touch over 7 days ago" };
  if (isCall(lastPerson) && lastPerson.callSecs >= TALK_SECONDS) return { kind: "skip", why: "the artist talked with her by phone" };
  if (msgs.some((m) => m.dir === "inbound" && m.at > lastPerson.at)) return { kind: "skip", why: "she replied after the artist" };
  // Belt and braces next to the table: our check-in anywhere in her thread → never a second one.
  if (msgs.some((m) => m.dir === "outbound" && m.at >= (ctx.guardSince ?? 0) && CHECK_IN_SENT.test(m.body))) return { kind: "skip", why: "already checked in (thread)" };
  // Nobody texted or called her in the last 48 hours (emails don't count — nurture emails run on their own).
  const lastOut = msgs.find((m) => m.dir === "outbound" && !isEmail(m));
  if (lastOut && now - lastOut.at < ctx.quietMs) return { kind: "later", why: "texted in the last 48 h" };
  // The AI was talking to her before the artist took over, and has been silent since.
  const lastCb = msgs.find(byCloseBot);
  if (!lastCb) return { kind: "skip", why: h.complete ? "the AI never talked to her" : "history too long to find the AI" };
  if (lastCb.at > lastPerson.at) return { kind: "skip", why: "the AI talked after the artist" };
  const lastMessageId = msgs[0].id;

  // 3. Stage + appointments.
  const opp = await oppCheck(tok, locationId, contactId, ctx.pipes);
  if (!opp.ok) return opp.error ? { kind: "error", why: opp.why } : { kind: "skip", why: opp.why };
  const ap = await apptCheck(tok, contactId);
  if (!ap.ok) return ap.error ? { kind: "error", why: ap.why } : { kind: "skip", why: ap.why };

  // 4. Daytime for her.
  // Her clock: her own time zone, else the studio's. Neither readable → wait (never guess New York).
  const ownTz = String(c.timezone ?? "");
  const ownOk = (() => { try { return !!ownTz && !!new Intl.DateTimeFormat("en-US", { timeZone: ownTz }); } catch { return false; } })();
  if (!ownOk && !ctx.locTz) return { kind: "later", why: "studio time zone unreadable" };
  const tz = leadTimezone(c, ctx.locTz);
  const at = nextDaytime(new Date(now), tz, SMS_DAY);
  if (at.getTime() > now && !ctx.anyHour) return { kind: "later", why: "night for her", at: at.toISOString() };

  // 5. The model reads the thread (cached "no" while the thread is unchanged).
  if (ctx.modelNo.get(contactId) === lastMessageId) return { kind: "skip", why: "model: no (thread unchanged)", lastMessageId };
  if (!ctx.judge && !ctx.client) return { kind: "error", why: "no model key" };
  const v = ctx.judge ? await ctx.judge(msgs) : await modelSays(ctx.client!, msgs);
  if (!v) return { kind: "error", why: "model gave no answer" };
  if (!v.send) return { kind: "skip", why: `model: ${v.why || "no"}`, lastMessageId, modelNo: true };

  const fieldId = await areaFieldId(tok, locationId, ctx.fields);
  const raw = fieldId ? ((c.customFields as { id: string; value?: unknown }[] | undefined) ?? []).find((f) => f.id === fieldId)?.value : undefined;
  const service = areaWords(raw);
  const first = firstName(String(c.firstName ?? ""), String(c.contactName ?? c.name ?? ""));
  const text = checkInText(first, service);
  return { kind: "send", text, first, service, touchAt: lastPerson.at, touchBy: isCall(lastPerson) ? "call" : "text", tz, lastMessageId, segments: smsSegments(text).segments };
}

// ─── Sending ────────────────────────────────────────────────────────────────
type SendResult = { ok: boolean; status: number; messageId: string | null; error: string | null; unknown: boolean };
/** One SMS from the sub-account. Never throws; a timeout or network error = "unknown" (it may have gone out). */
async function sendSms(tok: string, contactId: string, message: string): Promise<SendResult> {
  try {
    const r = await fetch(`${GHL}/conversations/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, Version: "2021-04-15", "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ type: "SMS", contactId, message }),
      signal: AbortSignal.timeout(25_000),
    });
    if (r.ok) {
      const j = (await r.json().catch(() => ({}))) as { messageId?: string; id?: string };
      return { ok: true, status: r.status, messageId: String(j.messageId ?? j.id ?? "") || null, error: null, unknown: false };
    }
    return { ok: false, status: r.status, messageId: null, error: `HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 180)}`, unknown: false };
  } catch (e) {
    return { ok: false, status: 0, messageId: null, error: e instanceof Error ? e.message : String(e), unknown: true };
  }
}

/* Live list of "ai off" leads in one studio, updated since `sinceIso` (newest first, up to 500). Null = unreadable. */
async function aiOffLeads(tok: string, locationId: string, sinceIso: string): Promise<string[] | null> {
  const ids: string[] = [];
  for (let page = 1; page <= 5; page++) {
    let r: Response | null = null;
    for (let i = 0; i < 4; i++) {
      r = await fetch(`${GHL}/contacts/search`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, Version: "2021-07-28", "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          locationId, page, pageLimit: 100,
          filters: [{ field: "tags", operator: "eq", value: "ai off" }, { field: "dateUpdated", operator: "range", value: { gte: sinceIso } }],
          sort: [{ field: "dateUpdated", direction: "desc" }],
        }),
        signal: AbortSignal.timeout(20_000),
      }).catch(() => null);
      if (r && r.status !== 429 && r.status < 500) break;
      await sleep(2_000 * (i + 1) + Math.floor(Math.random() * 1_000));
    }
    if (!r || !r.ok) return null;
    const cs = (((await r.json().catch(() => ({}))) as { contacts?: { id?: string }[] }).contacts ?? []);
    for (const c of cs) if (c.id) ids.push(String(c.id));
    if (cs.length < 100) break;
  }
  return ids;
}

/* One run at a time: a lease row in app_settings, taken with a conditional
   update (only when the last lease has run out). Null = another run holds it. */
async function takeLock(svc: Svc): Promise<string | null> {
  const nowIso = new Date().toISOString();
  await svc.from("app_settings").upsert({ key: LOCK_KEY, value: { until: "1970-01-01T00:00:00.000Z", run: null }, updated_at: nowIso }, { onConflict: "key", ignoreDuplicates: true });
  const run = randomUUID();
  const { data, error } = await svc.from("app_settings")
    .update({ value: { until: new Date(Date.now() + LOCK_MS).toISOString(), run }, updated_at: nowIso })
    .eq("key", LOCK_KEY).lt("value->>until", nowIso).select("key");
  return !error && data?.length ? run : null;
}
async function dropLock(svc: Svc, run: string) {
  await svc.from("app_settings").update({ value: { until: new Date().toISOString(), run: null }, updated_at: new Date().toISOString() })
    .eq("key", LOCK_KEY).eq("value->>run", run);
}

// ─── The run ────────────────────────────────────────────────────────────────
export type AiBackOnPreview = { locationId: string; studio: string; contactId: string; name: string; touchAt: string; touchBy: string; text: string };
export type AiBackOnRun = {
  enabled: boolean; dryRun: boolean; tableMissing?: boolean; locked?: boolean;
  studios: number; studiosNoCloseBot: number; candidates: number; checked: number; unchecked: number;
  sent: number; aiRestored: Record<string, number>; alerts: number;
  skipped: Record<string, number>; later: Record<string, number>;
  errors: string[]; partial: boolean;
  wouldSend?: AiBackOnPreview[];
  sentList?: (AiBackOnPreview & { ai: AiRestore["result"] | "not run" })[];
  skippedList?: { contactId: string; studio: string; why: string }[];
};

const bump = (o: Record<string, number>, k: string) => { o[k] = (o[k] ?? 0) + 1; };
const reasonKey = (why: string) => (why.startsWith("model:") ? "model: no" : why.startsWith("stage:") ? "stage" : why.startsWith("tag:") ? why : why.replace(/\(.*\)/, "").trim());
const shuffle = <T,>(a: T[]): T[] => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/* dryRun: nothing is sent or written — returns who WOULD get the text now.
   Test runs only (scripts, never the cron): `only` limits the run to the
   named contacts, `quietMs` stands in for the 48 hours, `extraStudios` adds
   internal accounts such as the Demo, `judge` stands in for the model (no
   model key on a laptop). */
export async function runAiBackOn(svc: Svc, opts: {
  dryRun?: boolean; now?: Date; budgetMs?: number; limit?: number; listSkips?: boolean;
  only?: { locationId: string; contactId: string }[]; quietMs?: number; extraStudios?: { locationId: string; name: string }[];
  judge?: Judge;
  testGuardSince?: number; // test runs only: the Demo thread keeps earlier test check-ins; ignore those older than this
  testAnyHour?: boolean;    // test runs only: skip the daytime gate (tested on real leads in the fleet dry run)
} = {}): Promise<AiBackOnRun> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const now = (opts.now ?? new Date()).getTime();
  const dryRun = !!opts.dryRun;
  // A real run must leave time for the last AI step before Vercel's 300 s cut.
  const budget = dryRun ? (opts.budgetMs ?? 230_000) : Math.min(opts.budgetMs ?? SEND_DEADLINE_MS, SEND_DEADLINE_MS);
  const limit = opts.limit ?? MAX_PER_RUN;
  const quietMs = opts.only ? (opts.quietMs ?? QUIET_MS) : QUIET_MS;
  let settings = await getAiBackOnSettings(svc);
  let settingsAt = Date.now();
  const res: AiBackOnRun = {
    enabled: settings.enabled, dryRun, studios: 0, studiosNoCloseBot: 0, candidates: 0, checked: 0, unchecked: 0, sent: 0, aiRestored: {}, alerts: 0,
    skipped: {}, later: {}, errors: [], partial: false,
    ...(dryRun ? { wouldSend: [] } : { sentList: [] }), ...(opts.listSkips ? { skippedList: [] } : {}),
  };
  // Off → nothing is sent. (Test scripts that name their contacts in `only` may send to those — never the cron.)
  if (!dryRun && !settings.enabled && !opts.only) return res;

  let lock: string | null = null;
  if (!dryRun) {
    lock = await takeLock(svc);
    if (!lock) { res.locked = true; return res; }
  }
  try {
    await runInner();
  } finally {
    if (lock) await dropLock(svc, lock).catch(() => undefined);
  }
  return res;

  async function runInner() {
    // Studios: Live V3 on Clients Master whose CloseBot is on, minus the owner's no-change studios.
    const dir = await loadDirectory(svc);
    const { data: cbRow } = await svc.from("app_settings").select("value").eq("key", CLIENTS_KEY).maybeSingle();
    const cb = (cbRow?.value ?? null) as CbClients | null;
    const cbFresh = !!cb?.at && now - Date.parse(cb.at) < CB_FRESH_MS;
    if (!cbFresh) {
      res.errors.push(`the daily CloseBot check is missing or older than 3 days (${cb?.at ?? "none"})`);
      if (!dryRun && !opts.only) return; // can't tell whose AI would answer — send nothing
    }
    const cbOn = new Set((cb?.clients ?? []).filter((r) => r.loc && r.s === "on").map((r) => r.loc as string));
    const studios = new Map<string, string>();
    for (const s of dir.v3) {
      if (!s.locationId || s.status.toLowerCase() !== "live" || SKIP_LOCATIONS.has(s.locationId)) continue;
      if (!cbOn.has(s.locationId)) { res.studiosNoCloseBot++; continue; }
      studios.set(s.locationId, s.business);
    }
    for (const s of opts.extraStudios ?? []) if (!SKIP_LOCATIONS.has(s.locationId)) studios.set(s.locationId, s.name);
    res.studios = studios.size;

    const toks = new Map<string, { tok: string | null; tz: string }>();
    const studioFor = async (loc: string) => {
      const hit = toks.get(loc);
      if (hit && (hit.tz || !hit.tok)) return hit;
      const t = hit?.tok ?? (await getAppLocationToken(loc)).token ?? null;
      let tz = "";
      for (let i = 0; t && !tz && i < 3; i++) { tz = await locationTimezone(loc, t); if (!tz) await sleep(1_500 * (i + 1)); }
      const v = { tok: t, tz };
      toks.set(loc, v); // an unreadable time zone is tried again on the next lead
      return v;
    };

    // Candidates, live from GHL.
    let cands: { locationId: string; contactId: string }[] = [];
    if (opts.only) {
      cands = opts.only.filter((c) => studios.has(c.locationId));
    } else {
      const since = new Date(now - MAX_AGE_MS - 86400_000).toISOString();
      const locs = [...studios.keys()];
      let li = 0;
      await Promise.all(Array.from({ length: 6 }, async () => {
        while (li < locs.length) {
          const loc = locs[li++];
          try {
            const st = await studioFor(loc);
            if (!st.tok) { res.errors.push(`${studios.get(loc)}: no token`); continue; }
            const ids = await aiOffLeads(st.tok, loc, since);
            if (!ids) { res.errors.push(`${studios.get(loc)}: lead search failed`); continue; }
            for (const id of ids) cands.push({ locationId: loc, contactId: id });
          } catch (e) {
            res.errors.push(`${studios.get(loc)}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }));
    }
    cands = shuffle([...new Map(cands.map((c) => [c.contactId, c])).values()]);

    // Memory: everyone ever checked in; the model's "no" while the thread is unchanged; failed sends.
    const done = new Set<string>();
    const modelNo = new Map<string, string>();
    const failedTimes = new Map<string, number>();
    const sentToday = new Map<string, number>();
    const dayStart = new Date(now - 24 * 3600_000).toISOString();
    const memSince = new Date(now - MEMORY_MS).toISOString();
    for (let p = 0; ; p += 1000) {
      const { data, error } = await svc.from(TABLE).select("contact_id, location_id, status, last_message_id, created_at").order("id").range(p, p + 999);
      if (isMissingTable(error)) { res.tableMissing = true; if (!dryRun) { res.errors.push(`${TABLE} table missing`); return; } break; }
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as { contact_id: string; location_id: string; status: string; last_message_id: string | null; created_at: string }[]) {
        if (r.status === "sent") {
          done.add(r.contact_id);
          if (r.created_at >= dayStart) sentToday.set(r.location_id, (sentToday.get(r.location_id) ?? 0) + 1);
        } else if (r.created_at >= memSince) {
          if (r.status === "model_no" && r.last_message_id) modelNo.set(r.contact_id, r.last_message_id);
          else if (r.status === "failed") failedTimes.set(r.contact_id, (failedTimes.get(r.contact_id) ?? 0) + 1);
        }
      }
      if (!data || data.length < 1000) break;
    }
    cands = cands.filter((c) => {
      if (done.has(c.contactId)) { bump(res.skipped, "already checked in"); return false; }
      if ((failedTimes.get(c.contactId) ?? 0) >= 2) { bump(res.skipped, "failed twice"); return false; }
      return true;
    });
    res.candidates = cands.length;

    const client = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 60_000 }) : null;
    const pipes: Pipes = new Map();
    const fields: FieldIds = new Map();
    let next = 0, sending = 0, stopped = false;
    const record = async (row: Record<string, unknown>): Promise<number | null> => {
      const { data, error } = await svc.from(TABLE).insert(row).select("id").maybeSingle();
      if (error) { res.errors.push(`record: ${error.message}`); return null; }
      return (data as { id: number } | null)?.id ?? null;
    };
    const stillOn = async () => {
      if (dryRun || opts.only) return true;
      if (Date.now() - settingsAt > 20_000) { settings = await getAiBackOnSettings(svc); settingsAt = Date.now(); }
      return settings.enabled;
    };

    async function one(c: { locationId: string; contactId: string }) {
      const studio = studios.get(c.locationId) ?? c.locationId;
      const st = await studioFor(c.locationId);
      if (!st.tok) { bump(res.skipped, "no studio token"); return; }
      let d: Decision;
      try {
        d = await decide({ tok: st.tok, locTz: st.tz, pipes, fields, client, judge: opts.only ? opts.judge : undefined, guardSince: opts.only ? opts.testGuardSince : undefined, anyHour: !!(opts.only && opts.testAnyHour), now, quietMs, maxAgeMs: MAX_AGE_MS, modelNo }, c.locationId, c.contactId);
      } catch (e) {
        d = { kind: "error", why: e instanceof Error ? e.message : String(e) };
      }
      res.checked++;
      if (d.kind === "skip") {
        bump(res.skipped, reasonKey(d.why));
        res.skippedList?.push({ contactId: c.contactId, studio, why: d.why });
        if (d.modelNo && !dryRun) await record({ contact_id: c.contactId, location_id: c.locationId, status: "model_no", reason: d.why, last_message_id: d.lastMessageId ?? null });
        return;
      }
      if (d.kind === "later") { bump(res.later, d.why); return; }
      if (d.kind === "error") { bump(res.skipped, "error"); res.errors.push(`${studio}: ${d.why}`); return; }

      const preview: AiBackOnPreview = { locationId: c.locationId, studio, contactId: c.contactId, name: d.first, touchAt: new Date(d.touchAt).toISOString(), touchBy: d.touchBy, text: d.text };
      if (dryRun) { res.wouldSend!.push(preview); return; }

      // Last gates right before the text (no await between the checks and the counters).
      if (elapsed() > SEND_DEADLINE_MS) { bump(res.later, "out of time this run"); return; }
      if (!(await stillOn())) { stopped = true; bump(res.later, "switched off during the run"); return; }
      if (res.sent + sending >= limit) { bump(res.later, "run limit"); return; }
      if ((sentToday.get(c.locationId) ?? 0) >= PER_STUDIO_DAY) { bump(res.later, "studio daily cap"); return; }
      sentToday.set(c.locationId, (sentToday.get(c.locationId) ?? 0) + 1);
      sending++;
      try {
        const s = await sendSms(st.tok, c.contactId, d.text);
        if (!s.ok) {
          if (!s.unknown && (s.status === 429 || s.status >= 500)) {
            // GHL busy: nothing went out — try again next run, no strike.
            sentToday.set(c.locationId, (sentToday.get(c.locationId) ?? 1) - 1);
            bump(res.later, "GHL busy on send");
            return;
          }
          if (!s.unknown) sentToday.set(c.locationId, (sentToday.get(c.locationId) ?? 1) - 1);
          // Unknown (timeout / network): it may have gone out — the thread check stops a second one.
          res.errors.push(`${studio}: send ${s.unknown ? "unknown" : "failed"} — ${s.error ?? s.status}`);
          await record({ contact_id: c.contactId, location_id: c.locationId, status: "failed", reason: `${s.unknown ? "unknown: " : ""}${s.error ?? `HTTP ${s.status}`}`, text: d.text, artist_touch_at: preview.touchAt, touch_by: d.touchBy, last_message_id: d.lastMessageId });
          return;
        }
        res.sent++;
        // Written before the AI step, so a cut-off run still remembers the text went out.
        const rowId = await record({
          contact_id: c.contactId, location_id: c.locationId, status: "sent", text: d.text, message_id: s.messageId,
          artist_touch_at: preview.touchAt, touch_by: d.touchBy, last_message_id: d.lastMessageId, ai_result: "pending",
        });
        const ai = await keepAiOn(st.tok, c.locationId, c.contactId, { messageId: s.messageId, text: d.text });
        bump(res.aiRestored, ai.result);
        res.sentList!.push({ ...preview, ai: ai.result });
        if (rowId != null) await svc.from(TABLE).update({ ai_result: ai.result, ai_tags_after: ai.tagsAfter }).eq("id", rowId);
        if (ai.result === "failed" || ai.result === "replied_during_restore") {
          res.errors.push(`${studio}: AI ${ai.result}${ai.error ? ` — ${ai.error}` : ""} (contact ${c.contactId})`);
          const filed = await fileAlert(svc, {
            type: "ai_back_on", severity: "high",
            title: `${studio}: ${d.first} got the AI check-in, but ${ai.result === "failed" ? "the AI did not switch back on" : "she replied while the AI was switching back on"} — please answer her`,
            detail: `Check-in sent: "${d.text}". The artist's last text or call was ${preview.touchAt.slice(0, 10)}. ${ai.error ?? ""}`.trim(),
            source_key: `ai_back_on:${c.contactId}`,
            meta: { link: `https://app.gohighlevel.com/v2/location/${c.locationId}/contacts/detail/${c.contactId}`, contact_name: d.first, location_id: c.locationId, contact_id: c.contactId, result: ai.result },
          }).catch(() => false);
          if (filed) res.alerts++;
        }
      } finally {
        sending--;
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        if (stopped) return;
        if (elapsed() > budget) { res.partial = true; return; }
        if (!dryRun && res.sent + sending >= limit) return;
        const c = cands[next++];
        if (!c) return;
        try {
          await one(c);
        } catch (e) {
          // A worker never dies: the others may be in the middle of switching an AI back on.
          bump(res.skipped, "error");
          res.errors.push(`${c.contactId}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }));
    res.unchecked = Math.max(0, cands.length - res.checked);
  }
}
