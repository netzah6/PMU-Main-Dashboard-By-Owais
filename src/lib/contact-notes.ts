import Anthropic from "@anthropic-ai/sdk";

/* Sales contact notes, one clean note per stage (owner ask 11/10/2026).

   Today every call and every survey adds a NEW note in the agency account:
   the survey ("Data about the lead"), the GHL "AI Phone Call Summarizer ->
   Notes" workflow (a full discovery Q&A after EVERY call over 60 s, even a
   bad-audio one: "Not discussed" x13), the Fathom demo recap and the
   closers' own typed notes. A closer opening the contact sees 5–10 notes,
   repeated and out of order.

   This reads them all and keeps (creates, then updates in place) up to three
   notes, one per stage of the journey:
     📋 DISCOVERY  – every discovery answer once (latest real answer wins)
     🎥 DEMO       – short recap of each demo: plan picked, objections, next step
     🤝 CLIENT     – dated log of every call after she closed
   A stage's note exists only once she reached that stage. Old notes are
   never deleted or edited. */

const GHL = "https://services.leadconnectorhq.com";
const MODEL = "claude-opus-5-5";
export const AGENCY_LOCATION_ID = "SfpNMJ5YU9lBkxss47lK";

export const DISCOVERY_QUESTIONS = [
  "How long PMU artist?", "Full or part time?", "Services offered?", "Price range?",
  "Clients right now?", "Where clients come from?", "Goal?", "What's stopping her?",
  "Decision maker?", "Zip code / area?", "Why now?", "Urgency factors", "Pain points",
  "What she tried before (failed attempts)",
] as const;

const HEAD = { discovery: "📋 DISCOVERY", demo: "🎥 DEMO", client: "🤝 CLIENT CALLS" } as const;
type Section = keyof typeof HEAD;

type RawNote = { id: string; body?: string; dateAdded: string; dateUpdated?: string; userId?: string | null; pinned?: boolean };
export type Organized = {
  stage: Section;
  discovery: { q: string; a: string | null; date: string | null }[];
  survey: { date: string; lines: string[] } | null;
  demos: { date: string; recap: string[]; plan: string | null; objections: string | null; next_step: string | null; recording: string | null }[];
  client_calls: { date: string; summary: string }[];
};

const text = (html: string) => html
  .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&rsquo;/g, "’").replace(/&quot;/g, '"')
  .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const us = (iso: string | null | undefined) => {
  const d = iso ? new Date(iso) : null;
  return d && !isNaN(+d) ? d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric", timeZone: "America/Los_Angeles" }) : "";
};
const isOurs = (body: string) => Object.values(HEAD).some((h) => text(body).startsWith(h));
export const isOrganizedNote = (body?: string) => !!body && isOurs(body);

const SYSTEM = `You organize a sales contact's notes for a PMU (permanent makeup) marketing agency. Closers read them before a call.
The journey: survey -> discovery call -> demo call -> closed (paying client).
You get every note on the contact (date, who wrote it, text). Some are automatic AI call summaries, some typed by a closer, one or more are the survey.
Return JSON only:
{"stage":"discovery|demo|client",
 "discovery":[{"q":"<question exactly as given>","a":"<short answer or null>","date":"<ISO date of the note the answer came from or null>"}],
 "survey":{"date":"<ISO>","lines":["<label: value>", ...]} | null,
 "demos":[{"date":"<ISO>","recap":["<short line>", ...],"plan":"<plan she picked or null>","objections":"<or null>","next_step":"<or null>","recording":"<url or null>"}],
 "client_calls":[{"date":"<ISO>","summary":"<1-2 short lines>"}]}
Rules:
- discovery: answer EVERY question in the given list, in that order. Use the LATEST real answer. "Not discussed", "None mentioned", "Not established" are NOT answers: ignore them. If an older answer differs, keep the latest and add the older one in brackets, e.g. "$550–$800 (June: $550)". Typed closer notes count. Never invent: null if never answered. Max ~20 words per answer.
- survey: the LATEST survey only, 4-8 short "label: value" lines, skip empty fields and long marketing text.
- demos: one entry per demo call (Fathom recaps or call summaries after a demo was booked). 2-4 recap lines max.
- client_calls: only calls after she became a paying client, oldest first.
- A call note with no real content (bad audio, callback request) is not an answer. Skip it.
- stage: given by the tags/pipeline below; only change it if the notes clearly prove a later stage.
- Very simple English, short phrases. No markdown.`;

export async function fetchNotes(token: string, contactId: string): Promise<RawNote[]> {
  const r = await fetch(`${GHL}/contacts/${encodeURIComponent(contactId)}/notes`, { headers: { Authorization: `Bearer ${token}`, Version: "2021-07-28", Accept: "application/json" } });
  if (!r.ok) throw new Error(`notes HTTP ${r.status}`);
  return (((await r.json()) as { notes?: RawNote[] }).notes ?? []).sort((a, b) => Date.parse(a.dateAdded) - Date.parse(b.dateAdded));
}

export function stageFromTags(tags: string[]): Section {
  const t = tags.map((x) => x.toLowerCase());
  if (t.includes("closed")) return "client";
  if (t.some((x) => x.startsWith("demo"))) return "demo";
  return "discovery";
}

export function organizePrompt(notes: RawNote[], tags: string[]): { system: string; user: string } | null {
  const raw = notes.filter((n) => n.body && !isOurs(n.body)).map((n) => ({ date: n.dateAdded, by: n.userId ? "closer (typed)" : "automation", text: text(n.body!).slice(0, 3000) }));
  if (!raw.length) return null;
  return { system: SYSTEM, user: `Stage from tags: ${stageFromTags(tags)} (tags: ${tags.join(", ")})\nDiscovery questions: ${JSON.stringify(DISCOVERY_QUESTIONS)}\n\nNOTES (oldest first):\n${JSON.stringify(raw)}\n\nJSON only.` };
}

export function parseOrganized(out: string, tags: string[]): Organized | null {
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return null;
  const j = JSON.parse(m[0]) as Organized;
  j.stage = (["discovery", "demo", "client"] as const).includes(j.stage) ? j.stage : stageFromTags(tags);
  j.discovery = Array.isArray(j.discovery) ? j.discovery : [];
  j.demos = Array.isArray(j.demos) ? j.demos : [];
  j.client_calls = Array.isArray(j.client_calls) ? j.client_calls : [];
  return j;
}

export async function organizeNotes(notes: RawNote[], tags: string[]): Promise<Organized | null> {
  const pr = organizePrompt(notes, tags);
  if (!pr) return null;
  const res = await new Anthropic().messages.create({ model: MODEL, max_tokens: 4000, system: pr.system, messages: [{ role: "user", content: pr.user }] });
  if (res.stop_reason === "refusal") return null;
  return parseOrganized(res.content.map((b) => (b.type === "text" ? b.text : "")).join(""), tags);
}

/* HTML bodies, one per section reached. */
export function renderNotes(o: Organized, today = new Date().toISOString()): Partial<Record<Section, string>> {
  const p = (s: string) => `<p>${s}</p>`;
  const head = (k: Section, extra = "") => p(`<strong>${HEAD[k]}</strong> · updated ${us(today)}${extra}`);
  const foot = p("<em>Built from all the notes on this contact. Old notes are kept below.</em>");
  const out: Partial<Record<Section, string>> = {};

  const answered = o.discovery.filter((d) => d.a);
  if (answered.length || o.survey) {
    // Most answers come from one call: say its date once, mark only the others.
    const days = answered.map((d) => us(d.date)).filter(Boolean);
    const main = days.sort((a, b) => days.filter((x) => x === b).length - days.filter((x) => x === a).length)[0] ?? "";
    out.discovery = head("discovery", o.stage !== "discovery" ? " · stage done" : "")
      + (main ? p(`<em>Answers from the call on ${main} unless marked.</em>`) : "")
      + o.discovery.map((d) => {
        const q = /[?:]$/.test(d.q) ? d.q : d.q + ":";
        const when = d.date && us(d.date) !== main ? ` <em>(${us(d.date)})</em>` : "";
        return p(`<strong>${esc(q)}</strong> ${d.a ? esc(d.a) + when : "—"}`);
      }).join("")
      + (o.survey ? p(`<strong>Survey ${us(o.survey.date)}:</strong>`) + o.survey.lines.map((l) => p("• " + esc(l))).join("") : "")
      + foot;
  }
  if (o.demos.length) {
    out.demo = head("demo") + o.demos.map((d) => p(`<strong>Demo ${us(d.date)}</strong>`)
      + d.recap.map((l) => p("• " + esc(l))).join("")
      + (d.plan ? p(`<strong>Plan:</strong> ${esc(d.plan)}`) : "")
      + (d.objections ? p(`<strong>Objections:</strong> ${esc(d.objections)}`) : "")
      + (d.next_step ? p(`<strong>Next step:</strong> ${esc(d.next_step)}`) : "")
      + (d.recording ? p(`<a href="${esc(d.recording)}">Recording</a>`) : "")).join("") + foot;
  }
  if (o.client_calls.length) {
    out.client = head("client") + o.client_calls.map((c) => p(`<strong>${us(c.date)}</strong> ${esc(c.summary)}`)).join("") + foot;
  }
  return out;
}

/* Create each section's note, or update the one we wrote before. Pinned, so
   they stay above the raw notes that keep coming in. */
export async function writeOrganized(token: string, contactId: string, notes: RawNote[], bodies: Partial<Record<Section, string>>): Promise<Record<string, string>> {
  const H = { Authorization: `Bearer ${token}`, Version: "2021-07-28", Accept: "application/json", "Content-Type": "application/json" };
  const done: Record<string, string> = {};
  for (const k of Object.keys(bodies) as Section[]) {
    const body = bodies[k]!;
    const mine = notes.filter((n) => n.body && text(n.body).startsWith(HEAD[k])).at(-1);
    const sameAsBefore = mine && mine.pinned && text(mine.body!).replace(/updated \d\d\/\d\d\/\d{4}/, "") === text(body).replace(/updated \d\d\/\d\d\/\d{4}/, "");
    if (sameAsBefore) { done[k] = "unchanged"; continue; }
    const url = mine ? `${GHL}/contacts/${encodeURIComponent(contactId)}/notes/${mine.id}` : `${GHL}/contacts/${encodeURIComponent(contactId)}/notes`;
    const r = await fetch(url, { method: mine ? "PUT" : "POST", headers: H, body: JSON.stringify({ body, pinned: true }) });
    done[k] = r.ok ? (mine ? "updated" : "created") : `HTTP ${r.status}`;
  }
  return done;
}
