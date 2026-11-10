import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAppLocationToken } from "@/lib/ghl-app";

/* Sales contact notes: one clean, pinned note per stage (owner ask 11/10/2026).

   Before: every call over 60 s added a NEW GPT note in the agency account
   (a full discovery Q&A even for a bad-audio / "call me in 10 min" call:
   "Not discussed" x13), every survey added a note, Fathom adds a demo note,
   closers type their own. 5–10 notes, repeated, out of order.

   Now: the "AI Phone Call Summarizer -> Notes" workflow no longer writes a
   note; it POSTs the call transcript (+ its GPT summary) to
   /api/webhooks/organize-notes. Each call is stored in sales_note_events
   (nothing is lost), then Claude rebuilds up to three PINNED notes from
   everything known about the contact:
     📋 DISCOVERY    – every discovery answer once (latest real answer wins)
     🎥 DEMO         – recap per demo + follow-up calls before she pays
     🤝 CLIENT CALLS – dated log of every call after she closed
   Calls with no real content change nothing. A stage's note appears only
   once she reached it. Survey, Fathom and typed notes stay where they are
   and are read as sources. Our notes are updated in place, never duplicated
   (per-contact lock), and a closer's edit inside one of them is kept. */

const GHL = "https://services.leadconnectorhq.com";
const MODEL = "claude-opus-5-5";
export const AGENCY_LOCATION_ID = "SfpNMJ5YU9lBkxss47lK";
const SALES_PIPELINE = "YA9eFBz6BVKNN8381dbx";
const CLIENT_PIPELINE = "rWQUdNLRfQj4g79s5sVH";
const MAX_ATTEMPTS = 5;

export const DISCOVERY_QUESTIONS = [
  "How long PMU artist?", "Full or part time?", "Services offered?", "Price range?",
  "Clients right now?", "Where clients come from?", "Goal?", "What's stopping her?",
  "Decision maker?", "Zip code / area?", "Why now?", "Urgency factors", "Pain points",
  "What she tried before (failed attempts)",
] as const;

const HEAD = { discovery: "📋 DISCOVERY", demo: "🎥 DEMO", client: "🤝 CLIENT CALLS" } as const;
export type Section = keyof typeof HEAD;
const SECTIONS: Section[] = ["discovery", "demo", "client"];
const RANK: Record<Section, number> = { discovery: 0, demo: 1, client: 2 };

export type RawNote = { id: string; body?: string; dateAdded: string; dateUpdated?: string; userId?: string | null; pinned?: boolean };
export type Organized = {
  skip?: boolean;
  stage: Section;
  discovery: { q: string; a: string | null; date: string | null }[];
  survey: { date: string; lines: string[] } | null;
  demos: { date: string; recap: string[]; plan: string | null; objections: string | null; next_step: string | null; recording: string | null }[];
  follow_ups: { date: string; summary: string }[];
  client_calls: { date: string; summary: string }[];
};
type Source = { date: string; kind: string; text: string };
type EventRow = { id: number; source: string; branch: string | null; transcript: string | null; summary: string | null; received_at: string; processed_at: string | null; attempts: number };
type StateRow = { contact_id: string; note_ids: Partial<Record<Section, string>>; bodies_hash: Partial<Record<Section, string>>; stage: string | null; updated_at: string };
type Ask = (pr: { system: string; user: string }) => Promise<string>;

/* ---------- small helpers ---------- */

export const noteText = (html: string) => html
  .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&rsquo;/g, "’").replace(/&quot;/g, '"')
  .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const us = (iso: string | null | undefined) => {
  const d = iso ? new Date(iso) : null;
  return d && !isNaN(+d) ? d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric", timeZone: "America/Los_Angeles" }) : "";
};
const sectionOf = (body?: string): Section | null => {
  const t = body ? noteText(body) : "";
  return SECTIONS.find((k) => t.startsWith(HEAD[k])) ?? null;
};
export const isOrganizedNote = (body?: string) => sectionOf(body) !== null;
// Content fingerprint, ignoring the "updated" date.
const fingerprint = (body: string) => createHash("sha1").update(noteText(body).replace(/updated \d\d\/\d\d\/\d{4}/, "")).digest("hex");
const ghlHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, Version: "2021-07-28", Accept: "application/json", "Content-Type": "application/json" });

export async function fetchNotes(token: string, contactId: string): Promise<RawNote[]> {
  const r = await fetch(`${GHL}/contacts/${encodeURIComponent(contactId)}/notes`, { headers: ghlHeaders(token) });
  if (!r.ok) throw new Error(`notes HTTP ${r.status}`);
  return (((await r.json()) as { notes?: RawNote[] }).notes ?? []).sort((a, b) => Date.parse(a.dateAdded) - Date.parse(b.dateAdded));
}

/* ---------- stage: sales pipeline first, tags as fallback ---------- */

let stageNames: Map<string, string> | null = null;
async function pipelineStageNames(token: string): Promise<Map<string, string>> {
  if (stageNames) return stageNames;
  const r = await fetch(`${GHL}/opportunities/pipelines?locationId=${AGENCY_LOCATION_ID}`, { headers: ghlHeaders(token) });
  const m = new Map<string, string>();
  for (const p of (((await r.json().catch(() => ({}))) as { pipelines?: { stages?: { id: string; name: string }[] }[] }).pipelines ?? []))
    for (const s of p.stages ?? []) m.set(s.id, s.name);
  if (m.size) stageNames = m;
  return m;
}
export function stageFromStageName(name: string): Section {
  if (/closed paying|pay per appointment/i.test(name)) return "client";
  if (/demo|showed|didn.t close|strategy|money|paid deposit/i.test(name)) return "demo";
  return "discovery";
}
export function stageFromTags(tags: string[]): Section {
  const t = tags.map((x) => x.toLowerCase());
  if (t.includes("closed")) return "client";
  if (t.some((x) => x.startsWith("demo"))) return "demo";
  return "discovery";
}
async function stageOf(token: string, contactId: string, tags: string[]): Promise<Section> {
  const fromTags = stageFromTags(tags);
  const r = await fetch(`${GHL}/opportunities/search?location_id=${AGENCY_LOCATION_ID}&contact_id=${encodeURIComponent(contactId)}`, { headers: ghlHeaders(token) });
  const opps = (((await r.json().catch(() => ({}))) as { opportunities?: { pipelineId: string; pipelineStageId: string; updatedAt?: string }[] }).opportunities ?? []);
  if (opps.some((o) => o.pipelineId === CLIENT_PIPELINE)) return "client";
  const sales = opps.filter((o) => o.pipelineId === SALES_PIPELINE).sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""))[0];
  if (!sales) return fromTags;
  const fromPipe = stageFromStageName((await pipelineStageNames(token)).get(sales.pipelineStageId) ?? "");
  return RANK[fromTags] > RANK[fromPipe] ? fromTags : fromPipe;
}

/* ---------- Claude ---------- */

const SYSTEM = `You keep a sales contact's notes clean for a PMU (permanent makeup) marketing agency. Closers read them right before a call.
Journey: survey -> discovery call -> demo call -> follow-up calls -> closed (paying client) -> client calls.
You get every source about the contact, oldest first: call transcripts, short AI call summaries, the survey, Fathom demo recaps, notes typed by closers, and edits a closer made inside the organized notes.
Return JSON only:
{"skip":false,
 "stage":"discovery|demo|client",
 "discovery":[{"q":"<question exactly as given>","a":"<short answer or null>","date":"<ISO date of the source it came from or null>"}],
 "survey":{"date":"<ISO>","lines":["<label: value>"]} | null,
 "demos":[{"date":"<ISO>","recap":["<short line>"],"plan":"<plan she picked or null>","objections":"<or null>","next_step":"<or null>","recording":"<url or null>"}],
 "follow_ups":[{"date":"<ISO>","summary":"<1-2 short lines>"}],
 "client_calls":[{"date":"<ISO>","summary":"<1-2 short lines>"}]}
Rules:
- A call with no real conversation (voicemail, no answer, bad audio, wrong number, "call me back later / in 10 minutes", only small talk) adds NOTHING anywhere. Never write "Not discussed".
- discovery: answer EVERY question in the given list, in that order. Use the LATEST real answer from any source (transcripts, summaries, typed notes). If an older answer differs, keep the latest and add the older one in brackets with its month, e.g. "$550–$800 (June: $550)". Never invent: null if never answered. Max ~20 words per answer.
- survey: the LATEST survey only, 4-8 short "label: value" lines, skip empty fields and long marketing text.
- demos: one entry per demo call (Fathom recaps, or a call where the offer/program was presented). 2-4 recap lines max.
- follow_ups: real calls after the first demo and before she became a paying client (payment talks, questions). Oldest first.
- client_calls: real calls after she became a paying client. Oldest first.
- Each call goes in ONE list only. Discovery answers heard in a later call still update "discovery".
- Text a closer typed inside an organized note is a fact: keep it.
- stage: start from the stage given below; move it later only if the sources clearly prove it (e.g. a demo happened).
- If NONE of the sources is about this agency's sales process (e.g. a vendor or personal call), return {"skip":true}.
- Very simple English, short phrases, no markdown.`;

export function organizePrompt(sources: Source[], stage: Section): { system: string; user: string } | null {
  if (!sources.length) return null;
  return { system: SYSTEM, user: `Stage from the sales pipeline: ${stage}\nDiscovery questions: ${JSON.stringify(DISCOVERY_QUESTIONS)}\n\nSOURCES (oldest first):\n${JSON.stringify(sources)}\n\nJSON only.` };
}

export function parseOrganized(out: string, stage: Section): Organized | null {
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return null;
  const j = JSON.parse(m[0]) as Organized;
  if (j.skip) return { skip: true, stage, discovery: [], survey: null, demos: [], follow_ups: [], client_calls: [] };
  j.stage = SECTIONS.includes(j.stage) && RANK[j.stage] >= RANK[stage] ? j.stage : stage;
  const arr = <T,>(v: T[] | undefined | null) => (Array.isArray(v) ? v : []);
  j.discovery = arr(j.discovery).filter((d) => d && d.q);
  j.demos = arr(j.demos).filter((d) => d && d.date).map((d) => ({ ...d, recap: arr(d.recap).map(String) }));
  j.follow_ups = arr(j.follow_ups).filter((c) => c && c.summary);
  j.client_calls = arr(j.client_calls).filter((c) => c && c.summary);
  j.survey = j.survey && Array.isArray(j.survey.lines) && j.survey.lines.length ? j.survey : null;
  return j;
}

const askClaude: Ask = async (pr) => {
  const res = await new Anthropic().messages.create({ model: MODEL, max_tokens: 6000, system: pr.system, messages: [{ role: "user", content: pr.user }] });
  if (res.stop_reason === "refusal") throw new Error("model refused");
  return res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
};

/* ---------- render ---------- */

export function renderNotes(o: Organized, today = new Date().toISOString()): Partial<Record<Section, string>> {
  const p = (s: string) => `<p>${s}</p>`;
  const head = (k: Section, extra = "") => p(`<strong>${HEAD[k]}</strong> · updated ${us(today)}${extra}`);
  const foot = p("<em>Kept up to date by the dashboard after every call. Add your own notes as a new note.</em>");
  const out: Partial<Record<Section, string>> = {};

  const answered = o.discovery.filter((d) => d.a);
  if (answered.length || o.survey) {
    // Most answers come from one call: say its date once, mark only the others.
    const days = answered.map((d) => us(d.date)).filter(Boolean);
    const count = (x: string) => days.filter((y) => y === x).length;
    const main = [...days].sort((a, b) => count(b) - count(a))[0] ?? "";
    out.discovery = head("discovery", o.stage !== "discovery" ? " · stage done" : "")
      + (main ? p(`<em>Answers from the call on ${main} unless marked.</em>`) : "")
      + o.discovery.map((d) => {
        const q = /[?:]$/.test(d.q) ? d.q : d.q + ":";
        const when = d.date && us(d.date) && us(d.date) !== main ? ` <em>(${us(d.date)})</em>` : "";
        return p(`<strong>${esc(q)}</strong> ${d.a ? esc(String(d.a)) + when : "—"}`);
      }).join("")
      + (o.survey ? p(`<strong>Survey ${us(o.survey.date)}:</strong>`) + o.survey.lines.map((l) => p("• " + esc(String(l)))).join("") : "")
      + foot;
  }
  if (o.demos.length || o.follow_ups.length) {
    out.demo = head("demo", o.stage === "client" ? " · stage done" : "")
      + o.demos.map((d) => p(`<strong>Demo ${us(d.date)}</strong>`)
        + d.recap.map((l) => p("• " + esc(l))).join("")
        + (d.plan ? p(`<strong>Plan:</strong> ${esc(String(d.plan))}`) : "")
        + (d.objections ? p(`<strong>Objections:</strong> ${esc(String(d.objections))}`) : "")
        + (d.next_step ? p(`<strong>Next step:</strong> ${esc(String(d.next_step))}`) : "")
        + (d.recording && /^https?:\/\/\S+$/.test(d.recording) ? p(`<a href="${esc(d.recording)}">Recording</a>`) : "")).join("")
      + (o.follow_ups.length ? p("<strong>Follow-up calls</strong>") + o.follow_ups.map((c) => p(`• <strong>${us(c.date)}</strong> ${esc(String(c.summary))}`)).join("") : "")
      + foot;
  }
  if (o.client_calls.length) {
    out.client = head("client") + o.client_calls.map((c) => p(`• <strong>${us(c.date)}</strong> ${esc(String(c.summary))}`)).join("") + foot;
  }
  return out;
}

/* ---------- sources ---------- */

const TRANSCRIPT_MAX = 15_000, BUDGET = 140_000;
function buildSources(notes: RawNote[], events: EventRow[], edits: Partial<Record<Section, string>>): Source[] {
  const src: Source[] = [];
  for (const n of notes) {
    if (!n.body || isOrganizedNote(n.body)) continue;
    const t = noteText(n.body);
    const kind = n.userId ? "note typed by a closer"
      : /^data about the lead/i.test(t) ? "survey"
      : /fathom\.video/i.test(t) ? "Fathom demo recap"
      : "AI call summary (old)";
    src.push({ date: n.dateAdded, kind, text: t.slice(0, 4000) });
  }
  // Newest calls get their full transcript; older ones fall back to the summary.
  let budget = BUDGET;
  const calls = events.filter((e) => e.source === "call").sort((a, b) => Date.parse(b.received_at) - Date.parse(a.received_at));
  for (const e of calls) {
    const tr = (e.transcript ?? "").trim(), sm = (e.summary ?? "").trim();
    if (tr && budget > 2000) {
      const t = tr.slice(0, Math.min(TRANSCRIPT_MAX, budget));
      budget -= t.length;
      src.push({ date: e.received_at, kind: "call transcript", text: t + (sm ? `\n\n[AI summary of this call] ${sm.slice(0, 1500)}` : "") });
    } else if (sm || tr) {
      src.push({ date: e.received_at, kind: "AI call summary", text: (sm || tr).slice(0, 2000) });
    }
  }
  for (const k of SECTIONS) if (edits[k]) src.push({ date: new Date().toISOString(), kind: `closer edit inside the organized ${k} note`, text: edits[k]!.slice(0, 4000) });
  return src.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

/* ---------- events in ---------- */

export async function recordEvent(svc: SupabaseClient, e: { contactId: string; source: "call" | "fathom"; branch?: string | null; transcript?: string | null; summary?: string | null }): Promise<{ id: number | null; duplicate: boolean }> {
  const transcript = (e.transcript ?? "").slice(0, 200_000).trim() || null, summary = (e.summary ?? "").slice(0, 20_000).trim() || null;
  const content_hash = createHash("sha1").update(`${e.source}|${transcript ?? ""}|${summary ?? ""}`).digest("hex");
  // GHL may retry a webhook: the same call for the same contact within 2 h = one event.
  if (e.source === "call") {
    const { data: dup } = await svc.from("sales_note_events").select("id").eq("contact_id", e.contactId).eq("content_hash", content_hash)
      .gte("received_at", new Date(Date.now() - 2 * 3600_000).toISOString()).limit(1);
    if (dup?.length) return { id: dup[0].id as number, duplicate: true };
  }
  const { data, error } = await svc.from("sales_note_events").insert({ contact_id: e.contactId, source: e.source, branch: e.branch ?? null, transcript, summary, content_hash }).select("id").single();
  if (error) throw new Error(`store event: ${error.message}`);
  return { id: data.id as number, duplicate: false };
}

/* ---------- the work ---------- */

export type ProcessResult = { contactId: string; busy?: boolean; stage?: Section; done?: Record<string, string>; skipped?: string; error?: string };

export async function processContact(svc: SupabaseClient, contactId: string, opts: { waitForFathom?: boolean; ask?: Ask } = {}): Promise<ProcessResult> {
  const { data: locked, error: lockErr } = await svc.rpc("sales_notes_lock", { cid: contactId, secs: 280 });
  if (lockErr) return { contactId, error: `lock: ${lockErr.message}` };
  if (!locked) return { contactId, busy: true }; // the holder re-checks for new events before it lets go
  let result: ProcessResult = { contactId };
  try {
    for (let round = 0; round < 3; round++) {
      const startedAt = new Date().toISOString();
      const { data: evs } = await svc.from("sales_note_events").select("id, source, branch, transcript, summary, received_at, processed_at, attempts").eq("contact_id", contactId).order("received_at");
      const events = (evs ?? []) as EventRow[];
      const pending = events.filter((e) => !e.processed_at && e.attempts < MAX_ATTEMPTS);
      result = await organizeOnce(svc, contactId, events, pending, { ask: opts.ask, waitForFathom: !!opts.waitForFathom && round === 0 });
      if (pending.length) {
        if (result.error) {
          for (const e of pending) await svc.from("sales_note_events").update({ attempts: e.attempts + 1, error: result.error.slice(0, 300) }).eq("id", e.id);
        } else {
          await svc.from("sales_note_events").update({ processed_at: new Date().toISOString(), error: result.skipped ?? null }).in("id", pending.map((e) => e.id));
        }
      }
      if (result.error) break;
      const { count } = await svc.from("sales_note_events").select("id", { count: "exact", head: true }).eq("contact_id", contactId)
        .is("processed_at", null).lt("attempts", MAX_ATTEMPTS).gt("received_at", startedAt);
      if (!count) break; // nothing arrived while we worked
    }
  } finally {
    await svc.from("sales_note_state").update({ lock_until: null }).eq("contact_id", contactId);
  }
  return result;
}

async function organizeOnce(svc: SupabaseClient, contactId: string, events: EventRow[], pending: EventRow[], opts: { waitForFathom: boolean; ask?: Ask }): Promise<ProcessResult> {
  try {
    const tok = await getAppLocationToken(AGENCY_LOCATION_ID);
    if (!tok.token) return { contactId, error: tok.error ?? "no GHL token" };
    const token = tok.token;
    const cr = await fetch(`${GHL}/contacts/${encodeURIComponent(contactId)}`, { headers: ghlHeaders(token) });
    if (cr.status === 404 || cr.status === 400 || cr.status === 422) return { contactId, skipped: "contact not found" };
    if (!cr.ok) return { contactId, error: `contact HTTP ${cr.status}` };
    const contact = ((await cr.json()) as { contact?: { tags?: string[]; locationId?: string } }).contact;
    if (contact?.locationId && contact.locationId !== AGENCY_LOCATION_ID) return { contactId, skipped: "not an agency contact" };
    const tags = contact?.tags ?? [];

    const { data: st } = await svc.from("sales_note_state").select("contact_id, note_ids, bodies_hash, stage, updated_at").eq("contact_id", contactId).maybeSingle();
    const state = (st ?? { contact_id: contactId, note_ids: {}, bodies_hash: {}, stage: null, updated_at: new Date(0).toISOString() }) as StateRow;
    const firstRun = !state.stage;

    let notes = await fetchNotes(token, contactId);
    /* Fathom pings on a new recording and writes its own note a bit later:
       wait (up to ~80 s) for a recap newer than the ping. */
    const fathomPing = pending.filter((e) => e.source === "fathom").at(-1);
    if (opts.waitForFathom && fathomPing) {
      const since = Date.parse(fathomPing.received_at) - 10 * 60_000;
      const hasRecap = () => notes.some((n) => !n.userId && !!n.body && /fathom\.video/i.test(n.body) && Date.parse(n.dateAdded) >= since);
      for (let i = 0; i < 4 && !hasRecap(); i++) { await new Promise((r) => setTimeout(r, 20_000)); notes = await fetchNotes(token, contactId); }
    }

    // Our notes: by stored id, else by header (first run, or a note made before state existed).
    const ours: Partial<Record<Section, RawNote>> = {};
    for (const k of SECTIONS) ours[k] = notes.find((n) => n.id === state.note_ids[k]) ?? notes.filter((n) => sectionOf(n.body) === k).at(-1);
    // A closer typed inside one of our notes: keep what they wrote.
    const edits: Partial<Record<Section, string>> = {};
    for (const k of SECTIONS) {
      const n = ours[k];
      if (n?.body && state.bodies_hash[k] && fingerprint(n.body) !== state.bodies_hash[k]) edits[k] = noteText(n.body);
    }

    const lastRun = firstRun ? 0 : Date.parse(state.updated_at);
    const newRaw = notes.some((n) => !!n.body && !isOrganizedNote(n.body) && Date.parse(n.dateUpdated ?? n.dateAdded) > lastRun);
    const stage = await stageOf(token, contactId, tags);
    const stageMoved = !firstRun && state.stage !== stage;
    if (!pending.length && !newRaw && !Object.keys(edits).length && !stageMoved) return { contactId, skipped: "nothing new" };

    const pr = organizePrompt(buildSources(notes, events, edits), stage);
    if (!pr) return { contactId, skipped: "no sources" };
    const o = parseOrganized(await (opts.ask ?? askClaude)(pr), stage);
    if (!o) return { contactId, error: "could not read the AI answer" };
    if (o.skip) return { contactId, skipped: "not a sales conversation" };

    const bodies = renderNotes(o);
    const done = await writeOrganized(token, contactId, ours, bodies);
    const noteIds = { ...state.note_ids }, hashes = { ...state.bodies_hash };
    for (const k of Object.keys(done) as Section[]) { const id = done[k]?.id; if (id) { noteIds[k] = id; hashes[k] = fingerprint(bodies[k]!); } }
    await svc.from("sales_note_state").update({ note_ids: noteIds, bodies_hash: hashes, stage: o.stage, updated_at: new Date().toISOString() }).eq("contact_id", contactId);
    const failed = Object.entries(done).filter(([, d]) => !d.id).map(([k, d]) => `${k}: ${d.status}`);
    return { contactId, stage: o.stage, done: Object.fromEntries(Object.entries(done).map(([k, d]) => [k, d.status])), ...(failed.length ? { error: failed.join("; ") } : {}) };
  } catch (e) {
    return { contactId, error: e instanceof Error ? e.message.slice(0, 200) : "error" };
  }
}

/* Create each section's note, or update ours in place. Pinned so they stay
   above the notes that keep coming in. Unchanged content = no write. */
async function writeOrganized(token: string, contactId: string, ours: Partial<Record<Section, RawNote>>, bodies: Partial<Record<Section, string>>): Promise<Partial<Record<Section, { status: string; id?: string }>>> {
  const done: Partial<Record<Section, { status: string; id?: string }>> = {};
  const base = `${GHL}/contacts/${encodeURIComponent(contactId)}/notes`;
  // Oldest stage first, so a NEW note for the current stage lands on top.
  for (const k of SECTIONS.filter((s) => bodies[s])) {
    const body = bodies[k]!, mine = ours[k];
    if (mine?.body && mine.pinned && fingerprint(mine.body) === fingerprint(body)) { done[k] = { status: "unchanged", id: mine.id }; continue; }
    let r = mine ? await fetch(`${base}/${mine.id}`, { method: "PUT", headers: ghlHeaders(token), body: JSON.stringify({ body, pinned: true }) }) : null;
    let status = mine ? "updated" : "created";
    if (!r || r.status === 404) { // ours was deleted by someone: write a new one
      r = await fetch(base, { method: "POST", headers: ghlHeaders(token), body: JSON.stringify({ body, pinned: true }) });
      status = "created";
    }
    if (!r.ok) { done[k] = { status: `HTTP ${r.status}` }; continue; }
    const j = (await r.json().catch(() => ({}))) as { note?: { id?: string } };
    done[k] = { status, id: j.note?.id ?? mine?.id };
  }
  return done;
}

/* Cron safety net: anything stored but not organized yet (crash, AI error,
   a contact that was busy). */
export async function sweepPending(svc: SupabaseClient, limit = 6): Promise<ProcessResult[]> {
  const { data } = await svc.from("sales_note_events").select("contact_id").is("processed_at", null).lt("attempts", MAX_ATTEMPTS)
    .lt("received_at", new Date(Date.now() - 3 * 60_000).toISOString()).order("received_at").limit(200);
  const ids = [...new Set((data ?? []).map((r) => r.contact_id as string))].slice(0, limit);
  const out: ProcessResult[] = [];
  for (const id of ids) out.push(await processContact(svc, id));
  return out;
}
