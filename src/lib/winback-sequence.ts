import { createServiceClient } from "@/lib/supabase/server";
import { GHL_BASE } from "@/lib/ghl-tasks";
import { fetchWithBackoff, getThread, isAutomatedMessage, type PmuAccount, type ThreadMessage } from "@/lib/ghl-conversations";
import { getAppLocationToken } from "@/lib/ghl-app";
import { sendSms } from "@/lib/blast";
import { nk, sameClient, squarePlans, prepaidCoverage } from "@/lib/ceo-growth";
import { getAgencyFinance } from "@/lib/ceo-finance";
import { AGENCY_TZ } from "@/lib/ceo-capacity";
import { setTag, type WinbackOffer, type WinbackRow } from "@/lib/winback";

/* Win-back text sequence (owner, 2026-10-10; confirmed 2026-10-19).
   Former clients on the "Follow up To PPS" sheet get, in small daily batches,
   newest leavers first:
     step 1  day 0   text   "what are you charging for brows these days?"
     step 2  day 3   text   the nudge — worded by the offer the owner approved
     step 3  day 7   email  the offer in writing
     step 4  day 14  text   close-out, then the win-back-no-reply tag
   A reply at any point stops the sequence — a HUMAN answers from the AI tab,
   never a bot. The owner starts each batch by hand ("▶ Start next batch",
   after a preview); the winback-send cron sends whatever is due, 9am–7pm in
   the person's own timezone. dryRun anywhere here = read, compute, write
   nothing, send nothing. */

export const NO_REPLY_TAG = "win-back-no-reply";
export const DEFAULT_SIZE = 20;
export const MAX_SIZE = 50;
const MAX_SENDS_PER_RUN = 50;
const SEND_GAP_MS = 400;
const READ_GAP_MS = 100;
/* Waiting time after each step: day 0 → day 3 → day 7 → day 14. */
const WAIT_DAYS: Record<number, number> = { 1: 3, 2: 4, 3: 7 };
const DEFAULT_TZ = "America/New_York";
const SEND_FROM_HOUR = 9, SEND_TO_HOUR = 19, RESUME_HOUR = 10;
/* Someone we talked to in the last two weeks must not get the cold opener
   (2026-10-19: Thalia Marin had an open billing thread from 10/14), and a
   text of hers that nobody answered blocks it for longer — it must be
   answered first, not talked over. Older than that, the thread is cold. */
const RECENT_CONTACT_DAYS = 14;
const UNANSWERED_DAYS = 60;
/* GHL stamps our own text a moment after we record the send; anything in
   the chat newer than this slack after last_sent_at was not us. */
const SELF_SLACK_MS = 60_000;
/* One cron run stops sweeping for replies after this long so Vercel never
   cuts it mid-send; whatever is left is checked by the next run (15 min). */
const RUN_BUDGET_MS = 240_000;

/* human = a teammate wrote to her by hand after the batch started (an answer
   to her reply, or a message of their own) — the sequence steps aside. */
export type StoppedReason = "replied" | "opted_out" | "failed" | "finished" | "current_client" | "human";
export type SequenceFields = {
  batch_no: number | null;
  batch_started_at: string | null;
  step: number;
  next_due_at: string | null;
  last_sent_at: string | null;
  replied_at: string | null;
  stopped_reason: StoppedReason | null;
  send_error: string | null;
};
export type SequenceRow = WinbackRow & SequenceFields;

// ─── The four messages (owner-approved drafts, 2026-10-19) ──────────────────
/* {first} = the person's first name. Steps 2 and 3 come in three versions,
   keyed by the offer the owner approved in the sheet — the text must never
   pitch a program he hasn't approved for that person (none = no program named). */
type OfferKey = WinbackOffer | "none";
export const TEMPLATES = {
  step1: "Hey {first}, it's Nicolas from PMU Bookings On Demand 👋 Quick question — what are you charging for brows these days?",
  step2: {
    pps: "Asking because we opened a few pay-per-appointment spots: no monthly fee, you only pay when a new client actually shows up. Thought of you 🙂 Want the details?",
    monthly: "Asking because a lot changed since we worked together — AI that books clients for you 24/7 and deposits collected for you. Want me to show you how it works now?",
    none: "Asking because we have a couple of new ways to work with artists now — want me to send you the details?",
  } satisfies Record<OfferKey, string>,
  step3Subject: "A quick one from Nicolas (PMU Bookings On Demand)",
  step3: {
    pps: "<p>Hi {first},</p><p>We'd love to work together again. We now have a pay-per-appointment program: no monthly fee — your new clients book with a $50 deposit (that covers us) and you pay $60 only when they show up for the first session. Touch-ups, upsells and referrals are 100% yours.</p><p>Reply to this email or text me back and I'll send you the details.</p><p>Nicolas<br>PMU Bookings On Demand</p>",
    monthly: "<p>Hi {first},</p><p>We'd love to work together again. A lot changed since we worked together: AI that books clients for you 24/7, deposits collected for you, and new funnels.</p><p>Let's go over the numbers together — reply to this email or text me back.</p><p>Nicolas<br>PMU Bookings On Demand</p>",
    none: "<p>Hi {first},</p><p>We'd love to work together again. We have new ways to work together now — reply and I'll send you the details.</p><p>Nicolas<br>PMU Bookings On Demand</p>",
  } satisfies Record<OfferKey, string>,
  step4: "Last one from me, {first} 🙌 If you ever want new brow clients again, just text me here — I'll make it easy. Wishing you a great season!",
} as const;

export type Outgoing = { step: number; channel: "SMS" | "Email"; text: string; subject?: string; html?: string };

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] ?? c));
const stripHtml = (s: string) => s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n").replace(/<[^>]+>/g, "").trim();

/** The message for a step, with the first name filled in. */
export function messageFor(step: number, offer: WinbackOffer | null, first: string): Outgoing {
  const key: OfferKey = offer ?? "none";
  const fill = (t: string, name: string) => t.replace(/\{first\}/g, name);
  if (step === 1) return { step, channel: "SMS", text: fill(TEMPLATES.step1, first) };
  if (step === 2) return { step, channel: "SMS", text: fill(TEMPLATES.step2[key], first) };
  if (step === 3) {
    const html = fill(TEMPLATES.step3[key], escapeHtml(first));
    return { step, channel: "Email", subject: TEMPLATES.step3Subject, html, text: stripHtml(fill(TEMPLATES.step3[key], first)) };
  }
  return { step: 4, channel: "SMS", text: fill(TEMPLATES.step4, first) };
}

/* "TAYLOR" / "carolina" as GHL stores them read like shouting or a typo in a
   text — a name typed in one case gets its first letter capitalised; a name
   with its own casing ("McKenna", "DeAnna") is left alone. */
const tidyName = (s: string) => (s === s.toUpperCase() || s === s.toLowerCase())
  ? s.replace(/[a-zÀ-ɏ]+/gi, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
  : s;

/** GHL first name, else the first word of the sheet's owner name, else "there". */
export function firstNameOf(contactFirst: string | null | undefined, ownerName: string): string {
  const c = String(contactFirst ?? "").trim();
  if (c) return tidyName(c);
  const w = String(ownerName ?? "").trim().split(/\s+/)[0] ?? "";
  return w && !w.startsWith("(") ? tidyName(w) : "there";
}

/* Is this text one of ours? The sequence's own messages in a thread must not
   look like a teammate wrote them. Compared with punctuation, emoji and HTML
   stripped (GHL may reflow them) and the name as a wildcard. */
const normText = (s: string) => stripHtml(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SEQUENCE_TEXT_RES = [TEMPLATES.step1, ...Object.values(TEMPLATES.step2), ...Object.values(TEMPLATES.step3), TEMPLATES.step4]
  .map((t) => new RegExp(t.split("{first}").map((piece) => escapeRe(normText(piece))).join(".{0,40}?")));
export function isSequenceText(body: string): boolean {
  const n = normText(body);
  return !!n && SEQUENCE_TEXT_RES.some((re) => re.test(n));
}

// ─── Who goes next: newest leavers first ────────────────────────────────────

const MONTHS3 = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "Aug 2026" / "March 2026" / "8/2026" / "2026-08" → "2026-08"; unknown → "" (sorts last). */
export function lastPaidKey(lastPaid: string | null): string {
  const t = String(lastPaid ?? "").trim().toLowerCase();
  let m = t.match(/([a-z]{3,})[a-z.]*\s*,?\s*(\d{4})/);
  if (m) {
    const i = MONTHS3.indexOf(m[1].slice(0, 3));
    if (i >= 0) return `${m[2]}-${String(i + 1).padStart(2, "0")}`;
  }
  m = t.match(/(\d{4})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}`;
  m = t.match(/(\d{1,2})\/(?:\d{1,2}\/)?(\d{4})/); // US month-first: 8/2026 or 8/15/2026
  if (m) return `${m[2]}-${m[1].padStart(2, "0")}`;
  return "";
}

/* "Annie Luoung (Xuan)" is one person under two names — the sheets write the
   alias in parentheses. Every variant is compared: the name without the
   parenthetical, and the alias — a one-word alias only together with the
   last name ("Xuan Luoung"), or "Eunice (Raquel) Martinez" would claim every
   Raquel on the list. */
export function nameVariants(name: string): string[] {
  const base = String(name ?? "").replace(/\(.*?\)/g, " ").replace(/\s+/g, " ").trim();
  const aliases = [...String(name ?? "").matchAll(/\(([^)]*)\)/g)].map((m) => m[1].replace(/\s+/g, " ").trim()).filter(Boolean);
  const last = base.split(" ").pop() ?? "";
  const out = [base, ...aliases.map((a) => (a.includes(" ") ? a : last ? `${a} ${last}` : ""))];
  return [...new Set(out.filter((v) => v.length > 1))];
}
/* One typo apart ("Luoung" on the Clients sheet, "Luong" on Financing —
   2026-10-19): a letter added, dropped or swapped in a name of 8+ characters
   still counts as the same person. Erring this way only ever keeps someone
   OFF the text list, which is the safe side of the current-client net. */
export function oneTypoApart(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 8 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
export function samePerson(a: string, b: string): boolean {
  const va = nameVariants(a), vb = nameVariants(b);
  return va.some((x) => vb.some((y) => sameClient(x, y) || oneTypoApart(nk(x), nk(y))));
}

type Svc = ReturnType<typeof createServiceClient>;
type CurrentClients = { month: string; names: Array<{ name: string; source: string }>; emails: Map<string, string> };

/* SAFETY NET (owner, 2026-10-19, after Rose Yang — a prepaid client — landed
   on the list): everyone who is paying us right now, from two independent
   sources. Square: every ACTIVE plan (prepaid ones included). Financing sheet:
   this month's tab — anyone with a payment, or listed as Paid Upfront / PPS /
   Grace. Either source unreadable → refuse to pick, never guess. */
export async function currentClients(svc: Svc): Promise<CurrentClients> {
  const plans = await squarePlans(svc);
  if (!plans.active.length) throw new Error("The Square plans snapshot is empty — can't check who is a current client, so no batch was started");
  const fin = await getAgencyFinance();
  const ym = new Intl.DateTimeFormat("en-CA", { timeZone: AGENCY_TZ, year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
  const month = fin.months.find((m) => m.ym === ym);
  if (fin.error || !month) throw new Error(`Can't read this month's Financing tab (${fin.error ?? `no ${ym} tab`}) — no batch was started`);
  // A lump paid months ago ("$3,485 - 5 + 2 months plan" in July) still
  // covers this month even when this month's tab forgot the Paid Upfront row.
  const covered = prepaidCoverage(fin.months).filter((c) => c.end >= ym);
  const names = [
    ...covered.map((c) => ({ name: c.name, source: `prepaid on the Financing sheet through ${c.end}` })),
    ...plans.active.map((p) => ({ name: p.name, source: "active Square plan" })),
    ...plans.prepaid.map((p) => ({ name: p.name, source: `prepaid Square plan (${p.cadence.toLowerCase()})` })),
    ...month.payers.filter((p) => p.amount > 0).map((p) => ({ name: p.name, source: `paid in ${month.label}` })),
    ...month.upfrontNames.map((n) => ({ name: n, source: `Paid Upfront in ${month.label}` })),
    ...month.ppsNames.map((n) => ({ name: n, source: `PPS in ${month.label}` })),
    ...month.graceNames.map((n) => ({ name: n, source: `Grace in ${month.label}` })),
  ].filter((e) => e.name.trim());
  const emails = new Map<string, string>();
  for (const p of [...plans.active, ...plans.prepaid]) if (p.email) emails.set(p.email.toLowerCase(), "active Square plan");
  return { month: month.label, names, emails };
}

/** Why this row is a current client, or null when nothing matches. */
export function currentClientReason(row: Pick<WinbackRow, "owner_name" | "business" | "email">, cc: CurrentClients): string | null {
  const email = String(row.email ?? "").trim().toLowerCase();
  if (email && cc.emails.has(email)) return `Current client: same email as an ${cc.emails.get(email)}`;
  for (const candidate of [row.owner_name, row.business ?? ""]) {
    if (!candidate.trim()) continue;
    const hit = cc.names.find((e) => samePerson(candidate, e.name));
    if (hit) return `Current client: matches "${hit.name}" (${hit.source})`;
  }
  return null;
}

export type Picked = { sheetRow: number; name: string; business: string | null; lastPaid: string | null; offer: WinbackOffer | null; contactId: string; email: string | null };
export type Skipped = { sheetRow: number; name: string; why: string };

/** Follow Up people whose sequence hasn't started (any chat verdict). */
async function notStartedRows(svc: Svc): Promise<SequenceRow[]> {
  const out: SequenceRow[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await svc.from("winback_contacts").select("*")
      .eq("active", true).is("batch_started_at", null).is("outcome", null).is("stopped_reason", null)
      .order("sheet_row").range(off, off + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as SequenceRow[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}
/** Pickable = found in GHL and the chat review said ok / never chatted. */
const pickable = (r: SequenceRow) => !!r.contact_id && (r.review_verdict === "ok" || r.review_verdict === "no_chat");

/* Next `size` people to start: Follow Up, found in GHL, chat review ok /
   never chatted, not started, not won/lost. Newest leavers first (by the
   sheet's "Last paid"), then sheet order. EVERY not-started person is screened
   against the current clients first (flagged ones too, so the owner sees them):
   a current client is dropped — and marked current_client in the table when
   this is a real run — so they can never be texted.
   `only` = the sheet rows the owner saw in the preview: the real run starts
   exactly those (still re-screened), never a fresh pick that could differ. */
export async function pickBatch(svc: Svc, size: number, opts: { dryRun?: boolean; only?: number[] } = {}): Promise<{ picked: Picked[]; skipped: Skipped[]; eligible: number }> {
  const rows = await notStartedRows(svc);
  const cc = await currentClients(svc);
  const skipped: Skipped[] = [];
  const open: SequenceRow[] = [];
  for (const r of rows) {
    const why = currentClientReason(r, cc);
    if (!why) { if (pickable(r)) open.push(r); continue; }
    // Reported every time, never written: a fuzzy match can be wrong ("An
    // Nguyen" vs "Loan Nguyen") and a stored stop would need a DB edit to undo.
    skipped.push({ sheetRow: r.sheet_row, name: r.owner_name, why });
  }
  open.sort((a, b) => lastPaidKey(b.last_paid).localeCompare(lastPaidKey(a.last_paid)) || a.sheet_row - b.sheet_row);
  const only = opts.only ? new Set(opts.only) : null;
  const chosen = only ? open.filter((r) => only.has(r.sheet_row)) : open.slice(0, Math.max(0, size));
  if (only) {
    // Someone from the preview who is no longer pickable (started, won/lost,
    // flagged, now a current client) is reported, never silently dropped.
    const seen = new Set(chosen.map((r) => r.sheet_row));
    for (const n of only) if (!seen.has(n) && !skipped.some((s) => s.sheetRow === n)) skipped.push({ sheetRow: n, name: `Sheet row ${n}`, why: "Changed since the preview — no longer in the pool" });
  }
  const picked = chosen.map((r) => ({
    sheetRow: r.sheet_row, name: r.owner_name, business: r.business, lastPaid: r.last_paid, offer: r.offer, contactId: r.contact_id!, email: r.email,
  }));
  return { picked, skipped, eligible: rows.filter(pickable).length };
}

// ─── GHL reads ──────────────────────────────────────────────────────────────

const H7 = (acct: PmuAccount) => ({ Authorization: `Bearer ${acct.token}`, Version: "2021-07-28", Accept: "application/json" });
const H4 = (acct: PmuAccount) => ({ Authorization: `Bearer ${acct.token}`, Version: "2021-04-15", Accept: "application/json" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shortDate = (at: number | string) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: AGENCY_TZ });

const validTz = (tz: unknown): string | null => {
  const s = String(tz ?? "").trim();
  if (!s) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: s }); return s; } catch { return null; }
};

type GhlContact = { firstName: string; phone: string; email: string; timezone: string; smsDnd: boolean; emailDnd: boolean };

/** null = the contact is gone from GHL; throws when GHL can't be read. */
async function readContact(acct: PmuAccount, contactId: string): Promise<GhlContact | null> {
  const r = await fetchWithBackoff(`${GHL_BASE}/contacts/${encodeURIComponent(contactId)}`, { headers: H7(acct) });
  if (r.status === 404) return null;
  if (r.status === 429) throw new Error("GHL is busy (rate limit) — try again in a minute");
  if (!r.ok) throw new Error(`GHL contact read failed (${r.status})`);
  const c = ((await r.json()) as { contact?: Record<string, unknown> }).contact ?? {};
  const dnd = (c.dndSettings ?? {}) as Record<string, { status?: string } | undefined>;
  // GHL writes a STOP reply as status "permanent" (not "active"), with
  // contact.dnd left false — anything but inactive/empty means don't text.
  const dndOn = (channel: string) => { const st = String(dnd[channel]?.status ?? "").toLowerCase(); return !!st && st !== "inactive"; };
  return {
    firstName: String(c.firstName ?? "").trim(),
    phone: String(c.phone ?? "").trim(),
    email: String(c.email ?? "").trim(),
    timezone: validTz(c.timezone) ?? DEFAULT_TZ,
    smsDnd: c.dnd === true || dndOn("SMS"),
    emailDnd: c.dnd === true || dndOn("Email"),
  };
}

type ConvState = { id: string; lastAt: number | null; inbound: boolean };
/* The person's conversations as GHL's search index lists them: each thread's
   last message direction + date (epoch ms or ISO). The index can lag behind
   the real chat by hours for replies sent from the GHL app, so anything that
   decides a send reads the thread itself (readThreads) as well. */
async function convSearch(acct: PmuAccount, contactId: string): Promise<ConvState[]> {
  const r = await fetchWithBackoff(`${GHL_BASE}/conversations/search?locationId=${acct.locationId}&contactId=${encodeURIComponent(contactId)}&limit=5`, { headers: H4(acct) });
  if (r.status === 429) throw new Error("GHL is busy (rate limit)");
  if (!r.ok) throw new Error(`GHL conversations search failed (${r.status})`);
  const convs = ((await r.json()) as { conversations?: Array<Record<string, unknown>> }).conversations ?? [];
  return convs.map((c) => {
    const raw = c.lastMessageDate;
    const at = typeof raw === "number" ? raw : Date.parse(String(raw ?? ""));
    return { id: String(c.id), lastAt: Number.isFinite(at) ? at : null, inbound: String(c.lastMessageDirection ?? "").toLowerCase() === "inbound" };
  });
}
/* The newest messages of up to three threads, oldest → newest. Media-only
   messages read as "[voice note]" / "[photo]" so a voice-note reply counts. */
async function readThreads(acct: PmuAccount, convs: ConvState[], limit: number): Promise<ThreadMessage[]> {
  const msgs: ThreadMessage[] = [];
  for (const c of convs.slice(0, 3)) {
    msgs.push(...await getThread(acct, c.id, { limit, labelMedia: true }));
    await sleep(READ_GAP_MS);
  }
  return msgs.filter((m) => m.dateAdded).sort((a, b) => a.dateAdded!.localeCompare(b.dateAdded!));
}
/* A real person's message: hers, or a teammate's typed one — not a workflow
   text and not one of the sequence's own. */
const isRealMessage = (m: ThreadMessage) => m.direction === "inbound" || (!isAutomatedMessage(m) && !isSequenceText(m.body));

/* Someone we are talking to right now must not get the cold "what are you
   charging?" opener (2026-10-19: Thalia Marin had an open billing complaint,
   Phoebe Osuoha an unanswered text). Null = no real message of a teammate's
   in the last RECENT_CONTACT_DAYS and no unanswered text of hers in the last
   UNANSWERED_DAYS; otherwise the reason to leave her out of this batch. */
async function recentContactReason(acct: PmuAccount, contactId: string, now: Date): Promise<string | null> {
  const recent = now.getTime() - RECENT_CONTACT_DAYS * 86_400_000;
  const unanswered = now.getTime() - UNANSWERED_DAYS * 86_400_000;
  const convs = await convSearch(acct, contactId);
  const live = convs.filter((c) => c.lastAt && (c.lastAt > recent || (c.inbound && c.lastAt > unanswered)));
  if (!live.length) return null;
  // The index can't tell a workflow text from a person — read the thread.
  const msgs = await readThreads(acct, live, 100);
  const real = msgs.filter((m) => Date.parse(m.dateAdded!) > unanswered && isRealMessage(m));
  const last = real[real.length - 1];
  if (!last) {
    // Only automated texts lately — fine. A thread GHL wouldn't show is not fine.
    return msgs.length ? null : `GHL shows a message on ${shortDate(live[0].lastAt!)} that couldn't be read — check the chat first`;
  }
  const when = shortDate(last.dateAdded!);
  if (last.direction === "inbound") return `She wrote to us on ${when} and nobody answered yet — reply from the chat first`;
  return Date.parse(last.dateAdded!) > recent ? `A teammate wrote to her on ${when} — too soon for the cold opener` : null;
}

type Activity = { kind: "replied" | "human"; at: string; why: string } | { kind: "unverified"; why: string } | null;
/* What happened in her chat since the batch started that the sequence did
   not do itself. Every in-sequence row is checked on every cron run, so her
   reply is caught before a teammate answers it (the answer makes the thread's
   last message outbound again — 2026-10-19, Thalia Marin's chat had exactly
   that shape). Cheap path: the search index. Thorough (always before a send,
   or whenever the index shows anything newer than our own last text): the
   thread itself, looking for her message after the start, or a teammate's. */
async function activitySince(acct: PmuAccount, r: SequenceRow, opts: { thorough: boolean }): Promise<Activity> {
  const startedAt = Date.parse(r.batch_started_at!);
  const ownUntil = (r.last_sent_at ? Date.parse(r.last_sent_at) : startedAt) + SELF_SLACK_MS;
  let convs: ConvState[];
  try { convs = await convSearch(acct, r.contact_id!); }
  catch (e) { return { kind: "unverified", why: `Couldn't check for a reply: ${e instanceof Error ? e.message : e}` }; }
  // Her message is the newest thing in a thread (a call counts too — it has no text).
  const herLast = convs.filter((c) => c.inbound && c.lastAt && c.lastAt > startedAt).map((c) => c.lastAt!);
  if (herLast.length) { const at = Math.max(...herLast); return { kind: "replied", at: new Date(at).toISOString(), why: `Wrote back on ${shortDate(at)}` }; }
  const newer = convs.some((c) => c.lastAt && c.lastAt > ownUntil);
  if (!opts.thorough && !newer) return null;
  if (!convs.length) return null; // never a conversation — nothing could have happened
  const msgs = await readThreads(acct, convs, 100);
  if (!msgs.length && r.step > 0) return { kind: "unverified", why: "GHL didn't return the chat messages — not sending unverified" };
  const after = msgs.filter((m) => Date.parse(m.dateAdded!) > startedAt);
  const hers = after.find((m) => m.direction === "inbound");
  if (hers) return { kind: "replied", at: hers.dateAdded!, why: `Wrote back on ${shortDate(hers.dateAdded!)}` };
  const teammate = after.find((m) => m.direction === "outbound" && isRealMessage(m));
  if (teammate) return { kind: "human", at: teammate.dateAdded!, why: `A teammate wrote to her on ${shortDate(teammate.dateAdded!)} — the sequence stepped aside, carry on from the chat` };
  return null;
}

async function addTag(acct: PmuAccount, contactId: string, tag: string): Promise<boolean> {
  const r = await fetchWithBackoff(`${GHL_BASE}/contacts/${encodeURIComponent(contactId)}/tags`, {
    method: "POST",
    headers: { ...H7(acct), "Content-Type": "application/json" },
    body: JSON.stringify({ tags: [tag] }),
  }).catch(() => null);
  return !!r && r.ok;
}

// ─── Starting a batch ───────────────────────────────────────────────────────

export type BatchPerson = Picked & { first: string; phone: string; timezone: string; text: string };
export type BatchResult = {
  dryRun: boolean;
  batchNo: number | null;
  dayZeroText: string;
  picked: BatchPerson[];
  skipped: Skipped[];
  /** People who could have been picked (before the current-client screen). */
  eligible: number;
};

/* Picks the batch and checks each person in GHL (first name, phone, timezone,
   do-not-disturb, and whether we are already talking to her). A real run
   stamps the batch on their rows and adds the win-back-2026 tag; the day-0
   text itself goes out from the cron within 15 minutes, so the button
   returns fast. dryRun = look only. sheetRows = start exactly the people the
   preview showed (the confirm button sends them), re-checked the same way. */
export async function startBatch(acct: PmuAccount, opts: { size?: number; dryRun?: boolean; sheetRows?: number[]; svc?: Svc } = {}): Promise<BatchResult> {
  const only = opts.sheetRows?.filter((n) => Number.isInteger(n)).slice(0, MAX_SIZE);
  const size = only?.length ? only.length : Math.min(MAX_SIZE, Math.max(1, Math.floor(opts.size ?? DEFAULT_SIZE)));
  const dryRun = opts.dryRun !== false;
  const svc = opts.svc ?? createServiceClient(); // injectable for scripts and tests
  const now = new Date();
  // A few spare candidates so someone with no phone doesn't shrink the batch.
  const { picked: candidates, skipped, eligible } = await pickBatch(svc, only?.length ? size : size + 10, { dryRun, only: only?.length ? only : undefined });
  const ready: BatchPerson[] = [];
  const dropped: Array<{ sheetRow: number; reason: StoppedReason; why: string }> = [];
  for (const p of candidates) {
    if (ready.length >= size) break;
    const c = await readContact(acct, p.contactId);
    await sleep(READ_GAP_MS);
    const why = !c ? "Contact is gone from GHL" : !c.phone ? "No phone in GHL" : c.smsDnd ? "SMS do-not-disturb is on in GHL" : null;
    if (why) {
      skipped.push({ sheetRow: p.sheetRow, name: p.name, why });
      dropped.push({ sheetRow: p.sheetRow, reason: c?.smsDnd ? "opted_out" : "failed", why });
      continue;
    }
    // In touch lately? Then not this batch (she stays in the pool for a later one).
    const talking = await recentContactReason(acct, p.contactId, now);
    await sleep(READ_GAP_MS);
    if (talking) { skipped.push({ sheetRow: p.sheetRow, name: p.name, why: talking }); continue; }
    const first = firstNameOf(c!.firstName, p.name);
    ready.push({ ...p, first, phone: c!.phone, timezone: c!.timezone, text: messageFor(1, p.offer, first).text });
  }
  if (dryRun) return { dryRun: true, batchNo: null, dayZeroText: TEMPLATES.step1, picked: ready, skipped, eligible };

  const { data: top } = await svc.from("winback_contacts").select("batch_no").not("batch_no", "is", null).order("batch_no", { ascending: false }).limit(1).maybeSingle();
  const batchNo = (Number(top?.batch_no) || 0) + 1;
  const nowIso = now.toISOString();
  for (const p of ready) {
    const { error } = await svc.from("winback_contacts")
      .update({ batch_no: batchNo, batch_started_at: nowIso, step: 0, next_due_at: nowIso, last_sent_at: null, replied_at: null, send_error: null })
      .eq("sheet_row", p.sheetRow);
    if (error) throw new Error(error.message);
    if (await setTag(acct, p.contactId, true)) await svc.from("winback_contacts").update({ tagged_at: nowIso }).eq("sheet_row", p.sheetRow);
  }
  // No phone / DND: out of the pool for good, so the next batch doesn't re-check them.
  for (const d of dropped) {
    await svc.from("winback_contacts").update({ stopped_reason: d.reason, send_error: d.why, next_due_at: null }).eq("sheet_row", d.sheetRow);
  }
  return { dryRun: false, batchNo, dayZeroText: TEMPLATES.step1, picked: ready, skipped, eligible };
}

// ─── Sending what is due (the cron) ─────────────────────────────────────────

type LocalParts = { y: number; m: number; d: number; h: number; min: number; s: number };
function localParts(at: Date, tz: string): LocalParts {
  const p: Record<string, number> = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at)) {
    if (x.type !== "literal") p[x.type] = Number(x.value);
  }
  return { y: p.year, m: p.month, d: p.day, h: p.hour, min: p.minute, s: p.second };
}
/** Texts go out 9:00–19:00 in the person's own timezone. */
export function inSendWindow(at: Date, tz: string): boolean {
  const h = localParts(at, tz).h;
  return h >= SEND_FROM_HOUR && h < SEND_TO_HOUR;
}
/* The instant that is `hour`:00 on a local calendar date in tz (two passes so
   a DST switch on that day lands right). */
function atLocal(tz: string, y: number, m: number, d: number, hour: number): Date {
  const wall = Date.UTC(y, m - 1, d, hour);
  const offsetAt = (t: number) => { const p = localParts(new Date(t), tz); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - t; };
  let t = wall - offsetAt(wall);
  t = wall - offsetAt(t);
  return new Date(t);
}
/** Outside the window → the next 10:00 local (today if it's early, else tomorrow). */
export function nextSendTime(at: Date, tz: string): Date {
  const p = localParts(at, tz);
  return atLocal(tz, p.y, p.m, p.h < SEND_FROM_HOUR ? p.d : p.d + 1, RESUME_HOUR);
}

const needsAppToken = (err?: string) => /HTTP 401|not authorized for this scope/i.test(err ?? "");
/* The keys-sheet token can lack the conversations-write scope; the
   marketplace app's location token carries it (same fallback as the AI tab). */
async function withAppToken<T extends { ok: boolean; error?: string }>(acct: PmuAccount, send: (token: string) => Promise<T>): Promise<T> {
  const first = await send(acct.token);
  if (first.ok || !needsAppToken(first.error)) return first;
  const tok = await getAppLocationToken(acct.locationId);
  if (!tok.token || tok.token === acct.token) return first;
  return send(tok.token);
}
const sendText = (acct: PmuAccount, contactId: string, text: string) => withAppToken(acct, (token) => sendSms(token, contactId, text));
async function sendEmail(acct: PmuAccount, contactId: string, subject: string, html: string): Promise<{ ok: boolean; error?: string }> {
  return withAppToken(acct, async (token) => {
    const r = await fetch(`${GHL_BASE}/conversations/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Version: "2021-04-15", "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ type: "Email", contactId, subject, html }),
    });
    if (r.ok) return { ok: true };
    return { ok: false, error: `HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 180)}` };
  });
}
const isOptOutError = (err: string) => /\bdnd\b|do not disturb|opt(ed)?[\s-]?out|unsubscrib/i.test(err);

export type RunResult = {
  dryRun: boolean;
  now: string;
  /** In-sequence people swept for a reply this run / left for the next run (time budget). */
  checked: number;
  unchecked: number;
  due: number;
  /** Real run: what went out. Dry run: what WOULD go out. */
  sent: Array<{ sheetRow: number; name: string; step: number; channel: "SMS" | "Email"; text: string; subject?: string; error?: string }>;
  replied: Array<{ sheetRow: number; name: string; at: string }>;
  pushed: Array<{ sheetRow: number; name: string; until: string; timezone: string }>;
  stopped: Array<{ sheetRow: number; name: string; reason: StoppedReason; why: string }>;
  skipped: Array<{ sheetRow: number; name: string; why: string }>;
};

/** Everyone in a started, unfinished sequence — the ones whose next step is due first. */
async function inSequenceRows(svc: Svc): Promise<SequenceRow[]> {
  const out: SequenceRow[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await svc.from("winback_contacts").select("*")
      .not("batch_started_at", "is", null).is("stopped_reason", null).lt("step", 4)
      .order("next_due_at").order("sheet_row").range(off, off + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as SequenceRow[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/* Every 15 minutes: EVERY person in a running sequence gets the reply check
   (so her text stops the sequence before anyone answers it), then for each
   person whose next step is due — quiet hours, then send step+1 and schedule
   the next one. One run sends at most 50 messages, ~400 ms apart, and stops
   sweeping after RUN_BUDGET_MS. dryRun computes the same lists and writes
   nothing. One person's GHL or Supabase error never stops the run. */
export async function runSequence(acct: PmuAccount, opts: { dryRun?: boolean; now?: Date; svc?: Svc; budgetMs?: number } = {}): Promise<RunResult> {
  const dryRun = opts.dryRun !== false;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const svc = opts.svc ?? createServiceClient(); // injectable for scripts and tests
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? RUN_BUDGET_MS;
  const rows = await inSequenceRows(svc);
  const isDue = (r: SequenceRow) => !!r.next_due_at && Date.parse(r.next_due_at) <= now.getTime();
  const out: RunResult = { dryRun, now: nowIso, checked: 0, unchecked: 0, due: rows.filter(isDue).length, sent: [], replied: [], pushed: [], stopped: [], skipped: [] };
  const patch = async (sheetRow: number, fields: Partial<SequenceFields> & { tagged_at?: string }) => {
    if (dryRun) return;
    const { error: e } = await svc.from("winback_contacts").update(fields).eq("sheet_row", sheetRow);
    if (e) throw new Error(e.message);
  };
  let sends = 0;

  for (const r of rows) {
    const who = { sheetRow: r.sheet_row, name: r.owner_name };
    if (Date.now() - started > budgetMs) { out.unchecked++; continue; }
    const due = isDue(r);
    try {
      // (a) A reply — or a teammate's own message — stops everything; a human
      // has the conversation from here. Checked for everyone, every run.
      const act = await activitySince(acct, r, { thorough: due });
      await sleep(READ_GAP_MS);
      out.checked++;
      if (act?.kind === "unverified") { if (due) out.skipped.push({ ...who, why: act.why }); continue; }
      if (act?.kind === "replied") {
        out.replied.push({ ...who, at: act.at });
        await patch(r.sheet_row, { replied_at: act.at, stopped_reason: "replied", send_error: null, next_due_at: null });
        continue;
      }
      if (act?.kind === "human") {
        out.stopped.push({ ...who, reason: "human", why: act.why });
        await patch(r.sheet_row, { stopped_reason: "human", send_error: act.why, next_due_at: null });
        continue;
      }
      if (!due) continue;
      if (sends >= MAX_SENDS_PER_RUN) { out.skipped.push({ ...who, why: `This run already sent ${MAX_SENDS_PER_RUN} — next run` }); continue; }

      let c: GhlContact | null;
      try { c = await readContact(acct, r.contact_id!); }
      catch (e) { out.skipped.push({ ...who, why: `Couldn't read the contact: ${e instanceof Error ? e.message : e}` }); continue; }
      await sleep(READ_GAP_MS);
      const step = r.step + 1;
      const msg = messageFor(step, r.offer, firstNameOf(c?.firstName, r.owner_name));
      const stop = async (reason: StoppedReason, why: string, revert: Partial<SequenceFields> = {}) => {
        out.stopped.push({ ...who, reason, why });
        await patch(r.sheet_row, { ...revert, stopped_reason: reason, send_error: why, next_due_at: null });
      };
      if (!c) { await stop("failed", "Contact is gone from GHL"); continue; }
      if (msg.channel === "SMS" && c.smsDnd) { await stop("opted_out", "SMS do-not-disturb is on in GHL"); continue; }
      if (msg.channel === "SMS" && !c.phone) { await stop("failed", "No phone in GHL"); continue; }
      // (b) Quiet hours in THEIR timezone.
      if (!inSendWindow(now, c.timezone)) {
        const until = nextSendTime(now, c.timezone).toISOString();
        out.pushed.push({ ...who, until, timezone: c.timezone });
        await patch(r.sheet_row, { next_due_at: until });
        continue;
      }
      // (c) Send step+1. The step is claimed in the table BEFORE the send, so
      // a Supabase hiccup right after a successful send can never make the
      // next run send the same text again (the worst case is one missed
      // step, never a duplicate).
      out.sent.push({ ...who, step, channel: msg.channel, text: msg.text, subject: msg.subject });
      if (dryRun) continue;
      const finished = step >= 4;
      await patch(r.sheet_row, {
        step, last_sent_at: nowIso, send_error: null,
        next_due_at: finished ? null : new Date(now.getTime() + WAIT_DAYS[step] * 86_400_000).toISOString(),
        ...(finished ? { stopped_reason: "finished" as const } : {}),
      });
      sends++;
      // A network error counts as "not sent" — same path as a GHL refusal, so
      // the claimed step is handed back instead of advancing with no trace.
      const res = await (async (): Promise<{ ok: boolean; error?: string }> => {
        try {
          return msg.channel === "SMS"
            ? await sendText(acct, r.contact_id!, msg.text)
            : c.email && !c.emailDnd ? await sendEmail(acct, r.contact_id!, msg.subject!, msg.html!) : { ok: false, error: c.email ? "Email do-not-disturb is on in GHL" : "No email in GHL" };
        } catch (e) { return { ok: false, error: `network: ${e instanceof Error ? e.message : String(e)}` }; }
      })();
      if (!res.ok && msg.channel === "SMS") {
        // Nothing went out: hand the claimed step back and stop her.
        out.sent.pop();
        await stop(isOptOutError(res.error ?? "") ? "opted_out" : "failed", res.error ?? "send failed", { step: r.step, last_sent_at: r.last_sent_at });
        await sleep(SEND_GAP_MS);
        continue;
      }
      // (d) Sent — or an email that failed: note it but keep going so the
      // day-14 text still goes out. last_sent_at moves to AFTER the send, so
      // the reply sweep knows our own text from anything newer.
      if (!res.ok) out.sent[out.sent.length - 1].error = res.error;
      const notes: string[] = res.ok ? [] : [res.error ?? "send failed"];
      if (finished && !(await addTag(acct, r.contact_id!, NO_REPLY_TAG))) notes.push(`Finished, but the ${NO_REPLY_TAG} tag couldn't be added in GHL — add it by hand`);
      await patch(r.sheet_row, { last_sent_at: new Date().toISOString(), send_error: notes.length ? notes.join(" · ") : null });
      await sleep(SEND_GAP_MS);
    } catch (e) {
      out.skipped.push({ ...who, why: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/** Where the sequence stands, for the batch button's tooltip and the API. */
export async function sequenceSummary(svc: Svc): Promise<{ eligible: number; inSequence: number; byStep: Record<number, number>; stopped: Record<string, number>; nextDueAt: string | null; lastBatch: number | null }> {
  const { count: eligible } = await svc.from("winback_contacts").select("*", { count: "exact", head: true })
    .eq("active", true).not("contact_id", "is", null).is("batch_started_at", null)
    .is("outcome", null).is("stopped_reason", null).in("review_verdict", ["ok", "no_chat"]);
  const rows: Array<{ step: number; stopped_reason: string | null; next_due_at: string | null; batch_no: number | null }> = [];
  for (let off = 0; ; off += 1000) {
    const { data } = await svc.from("winback_contacts").select("step, stopped_reason, next_due_at, batch_no").not("batch_started_at", "is", null).range(off, off + 999);
    rows.push(...((data ?? []) as typeof rows));
    if (!data || data.length < 1000) break;
  }
  const byStep: Record<number, number> = {};
  const stopped: Record<string, number> = {};
  let nextDueAt: string | null = null, lastBatch: number | null = null;
  for (const r of rows) {
    if (r.stopped_reason) stopped[r.stopped_reason] = (stopped[r.stopped_reason] ?? 0) + 1;
    else {
      byStep[r.step] = (byStep[r.step] ?? 0) + 1;
      if (r.next_due_at && (!nextDueAt || r.next_due_at < nextDueAt)) nextDueAt = r.next_due_at;
    }
    if (r.batch_no != null && (lastBatch === null || r.batch_no > lastBatch)) lastBatch = r.batch_no;
  }
  return { eligible: eligible ?? 0, inSequence: rows.filter((r) => !r.stopped_reason).length, byStep, stopped, nextDueAt, lastBatch };
}
