import Anthropic from "@anthropic-ai/sdk";
import { createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken } from "@/lib/ghl-app";
import { locationTimezone } from "@/lib/onebox";
import { firstName, hasPaidTag, leadTimezone, nextDaytime, readContact } from "@/lib/pick-email";
import { AUTOMATED_SOURCES, keepAiOn, lowerTags, postSms, smsSegments, type AiRestore } from "@/lib/pick-sms";
import { loadDirectory } from "@/lib/closebot-coverage";

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
   - a Live V3 studio on Clients Master, except the studios the owner keeps
     out of all changes (SKIP_LOCATIONS);
   - she has "ai off" and "(v3)"; no paid tag, no goodbye / declining /
     stop / opt-out tag; SMS do-not-disturb off;
   - the AI (CloseBot) talked to her, and after that a PERSON took over: an
     outbound text with no app name that no automation sent, or an outbound
     call (GHL's export names every app's message, so a text with no app
     name was typed by a person — same rule as src/lib/pick-sms.ts);
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
   - at most one check-in per lead per 30 days; daytime for her
     (10 AM – 6 PM her time); a daily cap per studio.

   What happens: the check-in goes out from the studio's own number; then
   keepAiOn (pick-sms.ts) takes "ai off" off and puts "ai on" + "(v3)" on,
   and keeps it that way through CloseBot's shutoff, which fires again on
   our own text. If she answers, CloseBot answers her.

   Ships OFF (app_settings "ai_back_on"). ?dry=1 on the cron shows who WOULD
   get the text and writes nothing. */

export const AI_BACK_ON_KEY = "ai_back_on";
const TABLE = "ai_back_on_people";
const GHL = "https://services.leadconnectorhq.com";

const QUIET_MS = 48 * 3600_000;      // owner 11/22: the AI comes back after 48 hours
const MAX_AGE_MS = 7 * 86400_000;    // takeovers from the last week only (older leads are win-back's job)
const REPEAT_MS = 30 * 86400_000;    // one check-in per lead per 30 days
const SMS_DAY = { from: 10, to: 18, resume: 10 }; // her clock
const PER_STUDIO_DAY = 15;
const MAX_PER_RUN = 25;               // texts per run (each needs ~1.5 min of AI-on watching)
const CONCURRENCY = 4;
const MODEL = process.env.AI_BACK_ON_MODEL || "claude-opus-5-5";

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
type Msg = { id: string; at: number; dir: "inbound" | "outbound" | ""; type: string; source: string; app: string; body: string };

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
      out.push({
        id: String(m.id ?? ""), at, dir: dir === "inbound" || dir === "outbound" ? dir : "", type,
        source: String(m.source ?? "").toLowerCase(),
        app: String(((m.meta as { marketplace?: { appName?: string } } | undefined)?.marketplace?.appName) ?? ""),
        body: String(m.body ?? "").trim(),
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
    const body = isCall(m) ? "(phone call)" : (m.body || "(no text)").replace(/\s+/g, " ").slice(0, 400);
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
type Ctx = { tok: string; locTz: string; pipes: Pipes; fields: FieldIds; client: Anthropic | null; judge?: Judge; now: number; quietMs: number; maxAgeMs: number; modelNo: Map<string, string> };

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
  const dnd = c.dnd === true || String(((c.dndSettings as Record<string, { status?: string }> | undefined)?.SMS?.status) ?? "") === "active";
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
  if (msgs.some((m) => m.dir === "inbound" && m.at > lastPerson.at)) return { kind: "skip", why: "she replied after the artist" };
  // Belt and braces next to the table: our check-in already in her thread since that touch → never a second one.
  if (msgs.some((m) => m.dir === "outbound" && m.at > lastPerson.at && CHECK_IN_SENT.test(m.body))) return { kind: "skip", why: "already checked in (thread)" };
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
  const tz = leadTimezone(c, ctx.locTz);
  const at = nextDaytime(new Date(now), tz, SMS_DAY);
  if (at.getTime() > now) return { kind: "later", why: "night for her", at: at.toISOString() };

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

// ─── The run ────────────────────────────────────────────────────────────────
export type AiBackOnPreview = { locationId: string; studio: string; contactId: string; name: string; touchAt: string; touchBy: string; text: string };
export type AiBackOnRun = {
  enabled: boolean; dryRun: boolean; tableMissing?: boolean;
  studios: number; candidates: number; checked: number; unchecked: number;
  sent: number; aiRestored: Record<string, number>;
  skipped: Record<string, number>; later: Record<string, number>;
  errors: string[]; partial: boolean;
  wouldSend?: AiBackOnPreview[];
  sentList?: (AiBackOnPreview & { ai: AiRestore["result"] })[];
  skippedList?: { contactId: string; studio: string; why: string }[];
};

const bump = (o: Record<string, number>, k: string) => { o[k] = (o[k] ?? 0) + 1; };
const reasonKey = (why: string) => (why.startsWith("model:") ? "model: no" : why.startsWith("stage:") ? "stage" : why.startsWith("tag:") ? why : why.replace(/\(.*\)/, "").trim());

/* dryRun: nothing is sent or written — returns who WOULD get the text now.
   Test runs only (scripts, never the cron): `only` limits the run to the
   named contacts (no candidate table read), `quietMs` stands in for the
   48 hours, `extraStudios` adds internal accounts such as the Demo. */
export async function runAiBackOn(svc: Svc, opts: {
  dryRun?: boolean; now?: Date; budgetMs?: number; limit?: number; listSkips?: boolean;
  only?: { locationId: string; contactId: string }[]; quietMs?: number; extraStudios?: { locationId: string; name: string }[];
  judge?: Judge; // test runs with `only` (no model key on a laptop): stands in for the model's look at the thread
} = {}): Promise<AiBackOnRun> {
  const started = Date.now();
  const budget = opts.budgetMs ?? 230_000;
  const now = (opts.now ?? new Date()).getTime();
  const dryRun = !!opts.dryRun;
  const limit = opts.limit ?? MAX_PER_RUN;
  const quietMs = opts.only ? (opts.quietMs ?? QUIET_MS) : QUIET_MS;
  const settings = await getAiBackOnSettings(svc);
  const res: AiBackOnRun = {
    enabled: settings.enabled, dryRun, studios: 0, candidates: 0, checked: 0, unchecked: 0, sent: 0, aiRestored: {},
    skipped: {}, later: {}, errors: [], partial: false,
    ...(dryRun ? { wouldSend: [] } : { sentList: [] }), ...(opts.listSkips ? { skippedList: [] } : {}),
  };
  // Off → nothing is sent. (Test scripts that name their contacts in `only` may send to those — never the cron.)
  if (!dryRun && !settings.enabled && !opts.only) return res;

  // Studios: Live V3 on Clients Master, minus the owner's no-change studios.
  const dir = await loadDirectory(svc);
  const studios = new Map<string, string>();
  for (const s of dir.v3) if (s.locationId && s.status.toLowerCase() === "live" && !SKIP_LOCATIONS.has(s.locationId)) studios.set(s.locationId, s.business);
  for (const s of opts.extraStudios ?? []) if (!SKIP_LOCATIONS.has(s.locationId)) studios.set(s.locationId, s.name);
  res.studios = studios.size;

  // Candidates: "ai off" leads whose last activity falls in the window (a pre-filter only — every check runs live).
  let cands: { locationId: string; contactId: string }[];
  if (opts.only) {
    cands = opts.only.filter((c) => studios.has(c.locationId));
  } else {
    cands = [];
    const locs = [...studios.keys()];
    const from = new Date(now - MAX_AGE_MS - 86400_000).toISOString();
    const to = new Date(now - QUIET_MS + 3600_000).toISOString();
    for (let i = 0; i < locs.length; i += 50) {
      for (let p = 0; ; p += 1000) {
        const { data, error } = await svc.from("ghl_lead_status").select("location_id, contact_id")
          .in("location_id", locs.slice(i, i + 50)).eq("ai_off", true).gte("activity_date", from).lte("activity_date", to)
          .order("contact_id").range(p, p + 999);
        if (error) throw new Error(`lead list: ${error.message}`);
        for (const r of data ?? []) if (r.contact_id && r.location_id) cands.push({ locationId: String(r.location_id), contactId: String(r.contact_id) });
        if (!data || data.length < 1000) break;
      }
    }
  }
  // One row per contact.
  cands = [...new Map(cands.map((c) => [c.contactId, c])).values()];

  // Already checked in (30 days), and the model's cached "no" answers.
  const done = new Set<string>();
  const modelNo = new Map<string, string>();
  const failedTimes = new Map<string, number>();
  const sentToday = new Map<string, number>();
  {
    const since = new Date(now - REPEAT_MS).toISOString();
    const dayStart = new Date(now - 24 * 3600_000).toISOString();
    for (let p = 0; ; p += 1000) {
      const { data, error } = await svc.from(TABLE).select("contact_id, location_id, status, last_message_id, created_at").gte("created_at", since).order("id").range(p, p + 999);
      if (isMissingTable(error)) { res.tableMissing = true; if (!dryRun) { res.errors.push(`${TABLE} table missing`); return res; } break; }
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as { contact_id: string; location_id: string; status: string; last_message_id: string | null; created_at: string }[]) {
        if (r.status === "sent") {
          done.add(r.contact_id);
          if (r.created_at >= dayStart) sentToday.set(r.location_id, (sentToday.get(r.location_id) ?? 0) + 1);
        } else if (r.status === "model_no" && r.last_message_id) modelNo.set(r.contact_id, r.last_message_id);
        else if (r.status === "failed") failedTimes.set(r.contact_id, (failedTimes.get(r.contact_id) ?? 0) + 1);
      }
      if (!data || data.length < 1000) break;
    }
  }
  cands = cands.filter((c) => {
    if (done.has(c.contactId)) { bump(res.skipped, "already checked in"); return false; }
    if ((failedTimes.get(c.contactId) ?? 0) >= 2) { bump(res.skipped, "failed twice"); return false; }
    return true;
  });
  res.candidates = cands.length;

  const client = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 60_000 }) : null;
  const toks = new Map<string, { tok: string | null; tz: string }>();
  const pipes: Pipes = new Map();
  const fields: FieldIds = new Map();
  const studioFor = async (loc: string) => {
    if (!toks.has(loc)) {
      const t = (await getAppLocationToken(loc)).token ?? null;
      toks.set(loc, { tok: t, tz: t ? await locationTimezone(loc, t) : "" });
    }
    return toks.get(loc)!;
  };

  let next = 0, sending = 0;
  const record = async (row: Record<string, unknown>) => {
    const { error } = await svc.from(TABLE).insert(row);
    if (error) res.errors.push(`record: ${error.message}`);
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      if (Date.now() - started > budget) { res.partial = true; return; }
      if (res.sent + sending >= limit) return;
      const c = cands[next++];
      if (!c) return;
      const studio = studios.get(c.locationId) ?? c.locationId;
      if (!dryRun && (sentToday.get(c.locationId) ?? 0) >= PER_STUDIO_DAY) { bump(res.later, "studio daily cap"); continue; }
      const st = await studioFor(c.locationId);
      if (!st.tok) { bump(res.skipped, "no studio token"); continue; }
      let d: Decision;
      try {
        d = await decide({ tok: st.tok, locTz: st.tz, pipes, fields, client, judge: opts.only ? opts.judge : undefined, now, quietMs, maxAgeMs: MAX_AGE_MS, modelNo }, c.locationId, c.contactId);
      } catch (e) {
        d = { kind: "error", why: e instanceof Error ? e.message : String(e) };
      }
      res.checked++;
      if (d.kind === "skip") {
        bump(res.skipped, reasonKey(d.why));
        res.skippedList?.push({ contactId: c.contactId, studio, why: d.why });
        if (d.modelNo && !dryRun) await record({ contact_id: c.contactId, location_id: c.locationId, status: "model_no", reason: d.why, last_message_id: d.lastMessageId ?? null });
        continue;
      }
      if (d.kind === "later") { bump(res.later, d.why); continue; }
      if (d.kind === "error") { bump(res.skipped, "error"); res.errors.push(`${studio}: ${d.why}`); continue; }

      const preview: AiBackOnPreview = { locationId: c.locationId, studio, contactId: c.contactId, name: d.first, touchAt: new Date(d.touchAt).toISOString(), touchBy: d.touchBy, text: d.text };
      if (dryRun) { res.wouldSend!.push(preview); continue; }

      // Send, then bring the AI back on and keep it on through CloseBot's shutoff.
      sentToday.set(c.locationId, (sentToday.get(c.locationId) ?? 0) + 1);
      sending++;
      try {
        const s = await postSms(st.tok, c.contactId, d.text);
        if (!s.ok) {
          res.errors.push(`${studio}: send ${s.error ?? s.status}`);
          sentToday.set(c.locationId, (sentToday.get(c.locationId) ?? 1) - 1);
          await record({ contact_id: c.contactId, location_id: c.locationId, status: "failed", reason: s.error ?? `HTTP ${s.status}`, text: d.text, artist_touch_at: preview.touchAt, last_message_id: d.lastMessageId });
          continue;
        }
        res.sent++;
        const ai = await keepAiOn(st.tok, c.locationId, c.contactId, { messageId: s.messageId, text: d.text });
        bump(res.aiRestored, ai.result);
        if (ai.result === "failed" || ai.result === "replied_during_restore") res.errors.push(`${studio}: AI ${ai.result}${ai.error ? ` — ${ai.error}` : ""} (contact ${c.contactId})`);
        res.sentList!.push({ ...preview, ai: ai.result });
        await record({
          contact_id: c.contactId, location_id: c.locationId, status: "sent", reason: null, text: d.text, message_id: s.messageId,
          artist_touch_at: preview.touchAt, touch_by: d.touchBy, last_message_id: d.lastMessageId, ai_result: ai.result, ai_tags_after: ai.tagsAfter,
        });
      } finally {
        sending--;
      }
    }
  }));
  res.unchecked = Math.max(0, cands.length - res.checked);
  return res;
}
