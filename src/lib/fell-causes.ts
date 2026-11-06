// "What could have caused the fall" (owner, 11/05/2026: "any possibility or anything
// that can actually cause that decrease, anything you have in mind, list it there").
// Every cause we can think of, on each fallen client's card, each marked by what our
// data really shows:
//   found    a problem that blocks deposits and is in the numbers now, or a change
//            with a date after the best months (saved, or written in a team note)
//   maybe    true today, but nobody saved when it began; or a fact that fits
//   unknown  can't be checked from here; the line says who to ask or where to look
//   fine     checked, and it doesn't look like the reason
// The rule that started this (owner, same day): never write a guess as if it were
// found. The old note said "She may take deposits herself (Zelle, cash)" whenever
// nothing else was found, and nobody had seen that. A wrong "fine" is as bad: a line
// is fine only when a number says so.
//
// The list is about the share of leads who pay. Ads that stop bring fewer leads, which
// is another thing, so those lines say so and never count as "the reason".
//
// The texts say "the client", never she or he: the sheet doesn't say who the owner is,
// and calls and hand-typed texts can come from staff or from our own team.
//
// Browser-safe: no server imports.

import type { ChangeItem } from "@/lib/funnel-timeline";
import { addDays, changeText, isOurChange } from "@/lib/funnel-timeline-view";
import { monthLabel, peakLabel, type MonthStat, type Peak } from "@/lib/funnel-freeze";

export type CauseState = "found" | "maybe" | "unknown" | "fine";
export type CauseGroup = "ads" | "page" | "pay" | "ai" | "artist" | "numbers";
/* `short` is what the card shows: a few words with the one number or date that
   matters (owner, 11/06/2026: "too much text... short, right to the point"). The rest
   opens on a click: a found or possible cause reads "Title. Text", one that can't be
   checked "Title? Text", and a fine one "Title? Not the reason. Text". `answer`
   replaces those words where others are truer ("Yes." for a change that happened but
   didn't hurt, "Not today." for a check of today only). `whole` marks a cause that by
   itself stops most deposits. */
export type Cause = { id: string; group: CauseGroup; state: CauseState; short: string; title: string; text: string; whole?: boolean; answer?: string };

export const CAUSE_GROUP_LABEL: Record<CauseGroup, string> = { ads: "Ads", page: "Page", pay: "Pay step", ai: "AI and texts", artist: "Artist", numbers: "Numbers" };
export const FINE_ANSWER = "Not the reason.";

export type BriefIssue = { code: string; title?: string; detail?: string };

/* The parts of the daily check-up (cpd_briefs.facts) read here. All optional: an old
   check-up may miss some. */
export type CauseFacts = {
  version?: string;
  budget?: number | null;
  spent7?: number;
  cpl30?: number | null;
  sheetLeads7?: number;
  sheetLeads30?: number;
  onebox?: { leads30: number; picked30: number; pickRate30: number | null } | null;
  ai?: { leads: number; engagedPct: number | null; offerPct: number | null; aiOffPct: number | null; hotWaiting: number } | null;
  kills?: { callDead: number; callQualified: number; textDead: number; textQualified: number };
  setup?: { price: number | null; offer: string; canCharge: boolean; reviewsRating: number | null; reviewsCount: number | null };
  fleet?: { pickRate: number | null; cpl30: number | null; engagedPct: number | null };
};

export type CauseInput = {
  /* Pacific day, YYYY-MM-DD. */
  today: string;
  peak: Peak;
  now: { l: number; d: number; picks: number; pageLeads: number };
  months: Record<string, MonthStat>;
  lastLead: string | null;
  /* The last day a new payer paid. */
  lastDeposit: string | null;
  /* True when no deposit was recorded for this client before 08/24/2026: the early
     months then say nothing about the rate. */
  earlyDepositsMissing: boolean;
  /* Program label as the sheet has it, e.g. "(V3)". */
  version: string;
  frozen: boolean;
  freeBooking: boolean;
  /* Our copy of the link sent for the deposit. */
  payLink: "ours" | "other" | "none";
  /* The daily check-up, only when it is fresh. */
  issues: BriefIssue[] | null;
  facts: CauseFacts | null;
  /* Middle values across live V3 clients. */
  fleetOfferPct: number | null;
  fleetAiOffPct: number | null;
  /* The ad account as the Performance sheet shows it today. */
  ads: { status: string | null; paused: boolean | null; buyer: string | null; coach: string | null; budget: number | null; spent7: number | null } | null;
  /* Team notes from the first day of the best months on, oldest first. */
  notes: { date: string; note: string }[];
  /* Saved changes to the funnel dated after the best months, oldest first. */
  changes: { day: string; items: ChangeItem[] }[];
  /* The day page saving started. Nothing older is saved. */
  firstSave: string;
  /* The day the one-box page was made. */
  pageStart: string | null;
  /* Split tests of this client's own page that started in the best months, up to 60
     days before them, or later. The day a paused test ended isn't saved. */
  tests: { name: string; running: boolean; from: string }[];
  /* The day the deposit-text test began, when this client's leads are in it. */
  depAskSince: string | null;
  /* The same other clients, in the best months and in the last 30 days. */
  others: { clients: number; then: { l: number; d: number }; now: { l: number; d: number } } | null;
};

const fmtDay = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;
const rate = (d: number, l: number) => (l > 0 ? (100 * d) / l : 0);
const pctText = (d: number, l: number) => `${+rate(d, l).toFixed(1)}%`;
const money = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
const clip = (s: string, n = 120) => { const c = Array.from(s.replace(/\s+/g, " ").trim()); return c.length > n ? `${c.slice(0, n - 1).join("")}…` : c.join(""); };
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/* Whole numbers for the short lines; the full sentence keeps the exact one. */
const whole = (n: number) => `${Math.round(n)}%`;
const daysBetween = (later: string, earlier: string) => Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);
const monthName = (key: string) => `${monthLabel(key)} ${key.slice(0, 4)}`;

export const peakEndDay = (p: Peak) => {
  const [y, m] = p.to.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/* How likely it is to see this few deposits if a given rate still held (Poisson).
   Against the best months it reads too sure: that rate is a small sample, picked
   because it was the highest. So the card also checks against the months before. */
export function chanceOfSoFew(base: { l: number; d: number }, leads30: number, deposits30: number): number {
  const expected = (base.d / base.l) * leads30;
  let term = Math.exp(-expected), sum = term;
  for (let k = 1; k <= deposits30; k++) { term *= expected / k; sum += term; }
  return Math.min(1, sum);
}

/* Human team notes begin on this day. */
const NOTES_START = "2026-06-17";
/* Look Busy was switched off on every funnel calendar that had it on (owner, 10/28/2026). */
const LOOK_BUSY_OFF = "2026-10-28";

/* Words in a team note that point at one kind of change. Each was run over all 1,222
   team notes on 11/06/2026 and the matches read by hand, twice: the wrong matches
   were ads switched off read as "$ off", plans read as changes, and "Switched offer"
   read as "switched off". A note is only quoted, with its date, under a title that
   says no more than the note does. */
const AI_WORD = "(?:ai|bot|closebot|close bot|reminders?|follow[- ]?ups?|nurture|texts|sms)";
export const NOTE = {
  /* A plan or a question, not a change. */
  plan: /\bsuggest|\bask(ed)? (\w+ ){0,2}(to|if)\b|\bmaybe\b|\bcan we\b|\bwill (change|update|try|switch|disconnect|turn|stop|pause|remove)\b|\bneed to\b|\bdidn'?t do it\b|\bdid not accept\b|\bapproved (to|the) change|\bif (the )?client approves|\bonce the client approves|\b(don'?t|doesn'?t) want\b|^\s*(to|try to)\b/i,
  price: /\bprices?\b|(?<!\bshe )\boffer|\bdiscount|\d\s?%\s?off\b|\$?\d{2,4}\s?off+\b|free consult|\$\s?\d+\s*(to|->|→)\s*\$?\s?\d/i,
  notPrice: /\bdeposit|\bspen[dt]\b|\bbudget/i,
  priceWord: /\bprices?\b|(?<!\bshe )\boffer\b/i,
  budget: /\bbudget|\bad\s?spend\b(?!\s+limit)|\bdaily spend\b|\bdollar campaign\b/i,
  /* Facebook could not charge the card. */
  card: /\bpa[a-z]{2,6}\s+(d?f[ai]{2}l\w*|declin\w*)|\bpayment\s+(unsuccess\w*|(technical )?error|did not push)|\bpayment (method|verification|need)|\bno (payment method|card details)|\b(has|due to|for) payment error|\berror on payment\b|\bpush through the payment\b|\badd funds\b|\baccount (is |was |got )?(disabled|restricted)|\bstill restricted\b|^\s*disabled\.?\s*$/i,
  ads: /\bads?\b|\bad ?sets?\b|\bcreative|\baudience|\bcampaign|\btargeting|\bradius|\bcity name|\bvideos?\b|\bzip ?codes?\b|\blaunch|^\s*paused\b|\bresum\w*|\bstopped running\b/i,
  notAds: /\bbudget|\bad\s?spen[dt]\b|\bdaily spend\b|\bpayment|\bneed to pay\b|\blimit\b|\bads manager\b|\bad account\b|\bmasterlist|\bmaster dashboard|\bpage access\b|\bbusiness info\b/i,
  off: new RegExp(`\\b${AI_WORD}\\b[^.,]{0,12}\\b(off|disconnect\\w*|stopped|paused|disabled|removed)\\b|\\b(turn\\w*|shut\\w*|switch\\w*)\\s+off\\s+(the\\s+|her\\s+)?${AI_WORD}\\b|\\b(stop\\w*|paus\\w*|disabl\\w*|remov\\w*|disconnect\\w*)\\s+(the\\s+|her\\s+|from\\s+)?${AI_WORD}\\b|\\bno (more )?(reminders?|follow[- ]?ups?)\\b`, "i"),
  busy: /\bbusy\b/i,
  away: /\bvacation|\baway\b|out of town|\bclosed\b|\bblock(ed)? (her |the |off |out )?(calendar|days?|dates?|week|time)|maternity|\bsick\b|\btravel|\btrip\b|\bcruise\b|\bhospital|\bemergency\b|\boverbooked\b|\bfully booked\b/i,
  unhappy: /\bcancel|\bunhappy|\brefund|\bquits?\b|\bchurn|not happy|\bcomplain|\bwants? to (stop|pause)\b|\b(asked|requested)( me)? to stop\b|\bstop everything\b|\bdoesn'?t have money\b|\bdeleted by the client\b/i,
  /* The program label was switched (V1, V2.3, V3). */
  program: /\b(switch\w*|chang\w*|back|moved?)\b[^.]{0,25}\b(FU )?V ?(1|2(\.3)?|3)\b/i,
  deposit: /\bdeposit\b[^.]{0,40}\$\s?\d|\$\s?\d+[^.]{0,25}\bdeposit\b/i,
  /* A status word, not news. */
  status: /^\s*(all go+[odf]+( now)?|payment (success\w*|done)|(now |is )?active( now)?|live( now)?|opti?mi?zed|no (page )?access[\w\s-]*|no enough data( yet)?|g[ai]ve (a |more )?(chance|time))\W*$/i,
};
const SENTENCE = /(?<=[.!?])\s+|\s+\+\s+|;\s*/;
/* A note says something was done when one of its sentences matches and that sentence
   isn't a plan. Used where a note often mixes a plan with a finished change. */
const did = (re: RegExp, note: string, skip?: RegExp) => note.split(SENTENCE).some((c) => re.test(c) && !NOTE.plan.test(c) && !(skip && skip.test(c)));

/* Page checks from the daily check-up that are true today; nobody saved when they began. */
const PAGE_GAP: Record<string, (i: BriefIssue) => string> = {
  bare_funnel: (i) => clip(((i.detail ?? "").split(". ")[0] || "pieces are missing").replace(/^missing:\s*/i, "missing "), 90),
  ig_building: () => "Instagram pictures aren't on the page",
  ig_first_row: () => "Instagram starts with a flyer or a selfie",
  ig_not_work: () => "Instagram doesn't show the client's work",
  no_price: () => "no price on the page",
  free_consult_no_price: () => "free consult with no price",
  offer_wording: () => "the offer isn't a dollar-off offer",
};
/* Saved changes of the price or the offer. */
const PRICE_KEY = /^(offer|originalPrice|discountedPrice|touchupPrice|firstTouchup)/;
/* Logged the first time they can be read, with a value and nothing before it: not a change. */
const FIRST_READ = new Set(["label", "budget", "test"]);

type Note = { date: string; note: string };
type Saved = { day: string; item: ChangeItem };

export function fellCauses(x: CauseInput): Cause[] {
  const out: Cause[] = [];
  const add = (id: string, group: CauseGroup, state: CauseState, short: string, title: string, text: string, opts: { whole?: boolean; answer?: string } = {}) => {
    out.push({ id, group, state, short, title, text, ...(opts.whole && state === "found" ? { whole: true } : {}), ...(opts.answer && state === "fine" ? { answer: opts.answer } : {}) });
  };
  const f = x.facts;
  const has = (code: string) => (x.issues ?? []).find((i) => i.code === code);
  const best = peakLabel(x.peak);
  const start = `${x.peak.from}-01`;
  const end = peakEndDay(x.peak);
  const then = Math.round(x.peak.l / 2);
  const buyer = x.ads?.buyer ? `the media buyer (${x.ads.buyer})` : "the media buyer";
  const coach = x.ads?.coach ? `the coach (${x.ads.coach})` : "the coach";
  /* For the short lines: just the name. */
  const buyerName = x.ads?.buyer || "the media buyer";
  const coachName = x.ads?.coach || "the coach";
  const NO_CHECKUP = "There is no fresh check-up for this client.";
  const NEW = "I can't tell if this is new.";
  const TOO_NEW = "This is only days old, so it can't explain a fall over 30 days.";
  const TODAY = "Not today.";
  const NOT_RATE = "This can bring fewer leads. It doesn't explain why a smaller part of the leads pay.";
  const tooNew = (day: string) => daysBetween(x.today, day) < 7;
  /* Pages are saved from firstSave on. When the best months ended before that, the
     time in between is a blind spot. */
  const blind = end < x.firstSave;
  const sinceSave = `since ${fmtDay(x.firstSave)}`;
  const peakRate = rate(x.peak.d, x.peak.l);
  const others = (n: number | null) => (n != null ? ` For other clients it is ${n}%.` : "");

  /* ── Dated changes ─────────────────────────────────────────────────── */
  /* A change is checked against the first full month after it: when the client still
     got deposits near the best rate in that month, the change likely didn't hurt. */
  const monthAfter = (day: string) => {
    const [y, m] = day.split("-").map(Number);
    const next = new Date(Date.UTC(y, m, 1));
    const key = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
    const stat = x.months[key];
    if (!stat || key >= x.today.slice(0, 7) || stat.l < 30) return null;
    const held = stat.d >= 5 && rate(stat.d, stat.l) >= peakRate * 0.75;
    const said = `In the month after (${monthName(key)}) the rate was ${pctText(stat.d, stat.l)} (${stat.d} of ${stat.l} leads)`;
    return { held, text: held ? `${said}, close to the ${pctText(x.peak.d, x.peak.l)} of the best months, so this alone is likely not the reason.` : `${said}.` };
  };
  /* And against the last full month before it: when the rate was already low then,
     the fall came first. Only months after the best months count. */
  const lowBefore = (day: string) => {
    const [y, m] = day.split("-").map(Number);
    const prev = new Date(Date.UTC(y, m - 2, 1));
    const key = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`;
    const stat = x.months[key];
    if (!stat || key <= x.peak.to || stat.l < 30 || rate(stat.d, stat.l) > peakRate * 0.6) return null;
    return `The rate was already ${pctText(stat.d, stat.l)} in ${monthName(key)} (${stat.d} of ${stat.l} leads), before this change.`;
  };
  type Kind = "open" | "new" | "early" | "held";
  const ANSWER: Record<Kind, string> = { open: "Yes.", new: "Yes, but only days ago.", early: "Yes, but the fall came first.", held: "Yes." };
  const kindOf = (day: string): { kind: Kind; tail: string | null } => {
    const after = monthAfter(day);
    if (after?.held) return { kind: "held", tail: after.text };
    if (tooNew(day)) return { kind: "new", tail: null };
    const before = lowBefore(day);
    if (before) return { kind: "early", tail: before };
    return { kind: "open", tail: after?.text ?? null };
  };
  const firstKind = (kinds: Kind[]): Kind => (["open", "new", "early", "held"] as Kind[]).find((k) => kinds.includes(k)) ?? "held";
  /* The few words for a dated change, by what the months around it show. */
  const changedShort = (what: string, kind: Kind, days: string[]) =>
    kind === "open" ? (days.length > 1 ? `${what} changed ${days.length} times from ${fmtDay(days[0])}` : `${what} changed ${fmtDay(days[0])}`)
      : kind === "new" ? `${what} changed only days ago`
        : kind === "early" ? `${what} changed after the fall began`
          : `${what} changed; rate stayed near best`;
  const notedShort = (what: string, kind: Kind, day: string) =>
    kind === "open" ? `${what}: team note ${fmtDay(day)}`
      : kind === "new" ? `${what}: team note only days ago`
        : kind === "early" ? `${what}: team note after the fall began`
          : `${what}: team note; rate stayed near best`;

  /* ── Team notes ────────────────────────────────────────────────────── */
  /* A note from the last week of the best months counts as after them: almost all of
     the best days ran before it. */
  const lateFrom = addDays(end, -6);
  const after = x.notes.filter((n) => n.date >= lateFrom);
  const during = x.notes.filter((n) => n.date < lateFrom);
  const afterLast = (day: string) => (x.lastDeposit && day > x.lastDeposit ? `, after the last new deposit on ${fmtDay(x.lastDeposit)}` : "");
  const quote = (n: Note) => `Team note ${fmtDay(n.date)}${afterLast(n.date)}: "${clip(n.note)}".`;
  /* Notes about one subject. The kind is the strongest one among them; the notes of
     that kind are quoted, each followed by what the months around it show. */
  type Dated = { kind: Kind; text: string; days: string[] };
  const dated = (list: Note[]): Dated => {
    const rows = list.map((n) => ({ n, ...kindOf(n.date) }));
    const kind = firstKind(rows.map((r) => r.kind));
    const pool = rows.filter((r) => r.kind === kind);
    const shown = pool.slice(0, 2);
    const parts = shown.flatMap((r, i) => (r.tail && !shown.slice(i + 1).some((later) => later.tail === r.tail) ? [quote(r.n), r.tail] : [quote(r.n)]));
    if (pool.length > shown.length) parts.push(`And ${plural(pool.length - shown.length, "more such note", "more such notes")}, the last on ${fmtDay(pool[pool.length - 1].n.date)}.`);
    if (kind === "new") parts.push(TOO_NEW);
    return { kind, text: parts.join(" "), days: pool.map((r) => r.n.date) };
  };
  /* The last note on a subject from inside the best months: what was in place then. */
  const lastDuring = (list: Note[]) => (list.length ? ` The last team note on this from ${best}: ${fmtDay(list[list.length - 1].date)}, "${clip(list[list.length - 1].note, 90)}".` : "");
  const done = (re: RegExp, from = after) => from.filter((n) => re.test(n.note) && !NOTE.plan.test(n.note));
  const used = new Set<string>();
  const take = (list: Note[]) => { for (const n of list) used.add(`${n.date}|${n.note}`); return list; };

  /* ── Saved changes ─────────────────────────────────────────────────── */
  const saved: Saved[] = x.changes.flatMap((c) => c.items
    .filter((item) => !(FIRST_READ.has(item.key) && item.from === undefined && item.to !== undefined))
    .map((item) => ({ day: c.day, item })));
  const savedText = (rows: Saved[]) =>
    rows.slice(0, 3).map((r) => `${fmtDay(r.day)}: ${changeText(r.item).replace(" (stays live)", "")}`).join("; ") + (rows.length > 3 ? `; and ${rows.length - 3} more` : "") + ".";
  const savedKind = (rows: Saved[]) => firstKind(rows.map((r) => kindOf(r.day).kind));
  const savedLine = (rows: Saved[]): Dated => {
    const kind = savedKind(rows);
    const tail = kind === "new" ? TOO_NEW : rows.map((r) => kindOf(r.day)).find((k) => k.kind === kind)?.tail ?? "";
    const pool = rows.filter((r) => kindOf(r.day).kind === kind);
    return { kind, text: `${savedText(pool)}${tail ? ` ${tail}` : ""}`, days: pool.map((r) => r.day) };
  };
  /* One subject, from team notes and saved changes together. `soft` subjects are never
     "found": the note alone doesn't show what changed. */
  const addDated = (id: string, group: CauseGroup, what: string, title: string, notes: Note[], rows: Saved[], extra = "", soft = false) => {
    const n = notes.length ? dated(notes) : null;
    const s = rows.length ? savedLine(rows) : null;
    const kind = firstKind([n?.kind, s?.kind].filter((k): k is Kind => !!k));
    const text = [n?.text, s ? `${n ? "Saved: " : ""}${s.text}` : null].filter(Boolean).join(" ") + extra;
    /* Days, not rows: a change with both a team note and a saved row on one day is one change. */
    const days = Array.from(new Set([n, s].filter((v): v is Dated => !!v && v.kind === kind).flatMap((v) => v.days))).sort();
    const short = changedShort(what, kind, days);
    add(id, group, kind === "open" ? (soft ? "maybe" : "found") : "fine", short, title, text, { answer: ANSWER[kind] });
  };

  /* ── Ads and leads ─────────────────────────────────────────────────── */
  const budget = f?.budget || x.ads?.budget || 0;
  const spent7 = f?.spent7 || x.ads?.spent7 || 0;
  const quietDays = x.lastLead ? daysBetween(x.today, x.lastLead) - 1 : 0;
  /* Quiet for long enough that 4+ leads should have come at this client's usual pace. */
  const quiet = !!x.lastLead && (x.now.l / 30) * quietDays >= 4;
  const lastLeadText = x.lastLead ? ` The last new lead came on ${fmtDay(x.lastLead)}.` : "";
  const ADS_OFF = "The ads are off or not spending";
  if (has("ads_off")) add("ads_off", "ads", "found", "Ads off: almost no spend, no lead in 7 days", ADS_OFF, `Almost no ad spend and no new lead in 7 days. ${NOT_RATE}`);
  else if (x.ads?.paused && (quiet || (f?.sheetLeads7 != null && f.sheetLeads7 <= 1))) add("ads_off", "ads", "found", "Campaign paused today: fewer leads", ADS_OFF, `Our Facebook report shows the campaign as paused today.${lastLeadText} ${NOT_RATE}`);
  else if (x.ads?.paused) add("ads_off", "ads", "unknown", "Ads off? Shows paused, but leads come", ADS_OFF, `The campaign we track shows as paused, but leads still come.${lastLeadText} Ask ${buyer} which campaign runs.`);
  else if (budget > 0 && spent7 >= budget * 7 * 0.7 && quiet) add("ads_off", "ads", "maybe", `No lead since ${fmtDay(x.lastLead as string)} (${money(Math.round(spent7))} spent in 7 days)`, "No new lead for days", `Facebook spent ${money(Math.round(spent7))} in the last 7 days, but no new lead came since ${fmtDay(x.lastLead as string)}.`);
  else if (budget > 0 && spent7 >= budget * 7 * 0.7) add("ads_off", "ads", "fine", `Ads on: ${money(Math.round(spent7))} spent in 7 days`, ADS_OFF, `Facebook spent ${money(Math.round(spent7))} in the last 7 days. The budget is ${money(budget)} a day.${lastLeadText} I can't see the weeks before.`, { answer: "Not in the last 7 days." });
  else if (budget > 0) add("ads_off", "ads", "maybe", `Ads spent ${money(Math.round(spent7))} of ${money(budget * 7)} in 7 days`, "The ads spend less than the budget", `Facebook spent ${money(Math.round(spent7))} in the last 7 days. The budget is ${money(budget)} a day.${lastLeadText}`);
  else if (quiet) add("ads_off", "ads", "maybe", `No lead since ${fmtDay(x.lastLead as string)}`, "No new lead for days: the ads may be off", `No new lead since ${fmtDay(x.lastLead as string)}. Our Facebook report shows no budget and no spend for this client. Ask ${buyer}.`);
  else add("ads_off", "ads", "unknown", "Ads off? Spend not in our report", ADS_OFF, `Our Facebook report shows no budget and no spend for this client.${lastLeadText} Ask ${buyer}.`);

  const status = (x.ads?.status ?? "").trim().toUpperCase();
  const cardAfter = take(after.filter((n) => NOTE.card.test(n.note)));
  const cardDuring = during.filter((n) => NOTE.card.test(n.note));
  const cardCounts = cardAfter.length
    ? `Team notes say the card failed ${plural(cardAfter.length, "time", "times")} after ${best}, the last on ${fmtDay(cardAfter[cardAfter.length - 1].date)}${cardDuring.length ? `, and ${plural(cardDuring.length, "time", "times")} in ${best}` : ""}.`
    : "";
  const spentText = budget > 0 ? ` Facebook spent ${money(Math.round(spent7))} in the last 7 days.` : "";
  const ACCOUNT = "Facebook can't charge the card, or disabled the account";
  if (/UNSETTLED|GRACE/.test(status)) add("ad_account", "ads", "found", "Ad card problem today: fewer leads", "Facebook can't charge the card today", `The ad account shows a payment problem today.${spentText}${cardCounts ? ` ${cardCounts}` : ""} ${NOT_RATE}`);
  else if (/DISABLED|CLOSED/.test(status)) add("ad_account", "ads", "found", "Ad account disabled today: fewer leads", "Facebook shows the ad account as disabled today", `${spentText.trim()}${cardCounts ? ` ${cardCounts}` : ""} ${NOT_RATE}`.trim());
  else if (cardAfter.length && cardAfter.every((n) => tooNew(n.date))) add("ad_account", "ads", "fine", "Card failed only days ago", ACCOUNT, `${cardCounts} ${TOO_NEW}`, { answer: ANSWER.new });
  else if (cardAfter.length) add("ad_account", "ads", "maybe", cardDuring.length ? `Notes: card failed ${plural(cardAfter.length, "time", "times")} after, ${cardDuring.length} in best months` : `Notes: card failed ${plural(cardAfter.length, "time", "times")} after best months`, "Team notes say Facebook could not charge the card", `${cardCounts}${start < NOTES_START ? ` Team notes only start on ${fmtDay(NOTES_START)}, so I can't tell how often it happened in ${best}.` : ""}${status === "ACTIVE" ? " The ad account is active today." : ""} ${NOT_RATE}`);
  else if (status === "ACTIVE") add("ad_account", "ads", "fine", "Ad account active; no note of a failed card", ACCOUNT, `The ad account is active today, and I found no team note about a failed card after ${best}.`, { answer: "Not that I can see." });
  else if (status) add("ad_account", "ads", "unknown", `Ad account problem? Status: ${clip(status, 20)}`, ACCOUNT, `The ad account status today is "${clip(status, 30)}". Ask ${buyer} what it means.`);
  else add("ad_account", "ads", "unknown", "Ad account problem? Can't see it", ACCOUNT, `I can't see this client's ad account. Ask ${buyer}.`);

  const volume = `${x.now.l} leads in 30 days. In ${best} it was about ${then} a month.`;
  if (x.now.l < then * 0.6) add("lead_volume", "ads", "maybe", `Leads down: ${x.now.l} now, ${then} in best months`, "Far fewer leads than in the best months", `${volume} Fewer leads bring fewer deposits. But this doesn't explain why a smaller part of the leads pay.`);
  else if (x.now.l >= then * 1.5) add("lead_volume", "ads", "maybe", `Leads up: ${x.now.l} now, ${then} in best months`, "Many more leads than before", `${volume} This can mean less serious leads. I can't check that.`);
  else add("lead_volume", "ads", "fine", `Leads: ${x.now.l} now, ${then} in best months`, "The number of leads changed a lot", volume);

  const budgetSaved = saved.filter((r) => r.item.key === "budget");
  const budgetNotes = take(done(NOTE.budget));
  const budgetToday = budget > 0 ? ` Today it is ${money(budget)} a day.` : "";
  if (budgetNotes.length || budgetSaved.length) addDated("budget", "ads", "Budget", "The ad budget changed", budgetNotes, budgetSaved);
  else add("budget", "ads", "unknown", `Budget changed? Ask ${buyerName}`, "The ad budget changed", `I found no team note about the budget after ${best}.${budgetToday}${lastDuring(done(NOTE.budget, during))} Ask ${buyer}.`);

  const isAd = (n: Note) => did(NOTE.ads, n.note, NOTE.notAds) && !NOTE.card.test(n.note);
  const adNotes = take(after.filter((n) => isAd(n) && !budgetNotes.includes(n)));
  const AD = "The ad, the audience or the ad's offer changed";
  if (adNotes.length) { const v = dated(adNotes); add("ad_changed", "ads", v.kind === "open" ? "maybe" : "fine", notedShort("Ads", v.kind, v.days[0]), v.kind === "open" ? "Team notes about the ads after the best months" : AD, v.text, { answer: ANSWER[v.kind] }); }
  else add("ad_changed", "ads", "unknown", `Ad or audience changed? Ask ${buyerName}`, AD, `I can't see the ads, and I found no team note about them after ${best}.${lastDuring(during.filter(isAd))} Ask ${buyer} what changed.`);

  const COST = "Leads cost more (old ad, small city, more artists advertising)";
  if (f?.cpl30 != null && f.cpl30 > 0 && f.fleet?.cpl30 != null && f.fleet.cpl30 > 0) {
    const text = `${money(f.cpl30)} per lead in the last 30 days. Other clients pay about ${money(f.fleet.cpl30)}. I don't have this client's cost from ${best}.`;
    if (f.cpl30 > f.fleet.cpl30 * 1.4) add("lead_cost", "ads", "maybe", `Lead cost ${money(f.cpl30)} (others ${money(f.fleet.cpl30)})`, COST, `${text} ${NEW}`);
    else add("lead_cost", "ads", "fine", `Lead cost ${money(f.cpl30)} (others ${money(f.fleet.cpl30)})`, COST, text, { answer: f.cpl30 <= f.fleet.cpl30 ? "Not more than for others." : "A bit more than for others." });
  } else add("lead_cost", "ads", "unknown", "Lead cost: no fresh data", COST, f ? `The check-up has no cost per lead for this client. Ask ${buyer}.` : NO_CHECKUP);

  add("lead_quality", "ads", "unknown", `Leads less serious? Ask ${buyerName}`, "The leads are less serious, or live too far away", `I have no survey answers from ${best} to compare with. Ask ${buyer}, and read a few new chats.`);
  add("same_people", "ads", "unknown", `Ad seen too often? Ask ${buyerName}`, "The same people see the ad again and again", `Ask ${buyer} for the Frequency number in Ads Manager.`);
  add("warm_leads", "ads", "unknown", "Leads knew the client before? Ask the client", "In the best months many leads already knew the client (followers, past clients)", "I can't see which leads already knew the client. Ask the client if the link was shared back then.");

  const SOURCE = "Many leads don't come through our booking page";
  const through = `${Math.min(x.now.pageLeads, x.now.l)} of ${x.now.l} leads came through the page in 30 days.`;
  if (x.now.l < 20) add("other_source", "ads", "unknown", "Leads skip our page? Too few to tell", SOURCE, "There are too few leads to tell.");
  else if (x.pageStart && daysBetween(x.today, x.pageStart) < 30) add("other_source", "ads", "unknown", "Leads skip our page? The page is new", SOURCE, `The page was made on ${fmtDay(x.pageStart)}, so it wasn't there for all of the 30 days. ${through}`);
  else if (x.now.pageLeads < x.now.l * 0.7) add("other_source", "ads", "maybe", `Only ${Math.min(x.now.pageLeads, x.now.l)} of ${x.now.l} leads came through the page`, SOURCE, `${through} ${NEW}`);
  else add("other_source", "ads", "fine", `${Math.min(x.now.pageLeads, x.now.l)} of ${x.now.l} leads came through the page`, SOURCE, through);

  add("pixel", "ads", "unknown", "Pixel problem? See the Pixel Checking tab", "Facebook isn't told who the good leads are (pixel)", "Look at this client's row on the Pixel Checking tab.");
  add("ad_comments", "ads", "unknown", "Bad ad comments? Look on Facebook", "Bad comments under the ad, or the ad looks old", "Open the ad on Facebook and read the comments.");

  /* ── The booking page ──────────────────────────────────────────────── */
  const engineRows = saved.filter((r) => r.item.key === "engine");
  const autoRows = saved.filter((r) => r.item.key === "instagram" || r.item.key === "reviews");
  const shared = (engineRows.length ? ` The page version that all clients share changed ${plural(engineRows.length, "time", "times")} ${sinceSave}.${engineRows.every((r) => tooNew(r.day)) ? " That is only days old." : " If it hurt, the other clients would fall too."}` : "")
    + (autoRows.length ? ` Instagram or Google reviews on the page changed by themselves ${plural(autoRows.length, "time", "times")}.` : "");
  const ours = saved.filter((r) => isOurChange(r.item) && r.item.key !== "engine" && !PRICE_KEY.test(r.item.key));
  const PAGE = "We changed something on this client's page";
  if (ours.length) addDated("page_change", "page", "Page", PAGE, [], ours, shared);
  else if (blind) add("page_change", "page", "unknown", `Page changed? Before ${fmtDay(x.firstSave)} not saved`, PAGE, `I see no saved change to this client's own page ${sinceSave}.${shared} Changes before that date weren't saved.`);
  else add("page_change", "page", "fine", "No change to this client's own page", PAGE, `Nothing changed on this client's own page since ${best}.${shared}`);

  if (x.pageStart) {
    const made = `The one-box page was made on ${fmtDay(x.pageStart)}.`;
    const TEST = "One test of the old page against the first one-box page (about 240 leads on each) showed no clear gap. Today's shorter page was not tested this way. So this is not proven.";
    const laterTest = x.tests.find((t) => t.from >= start);
    if (x.pageStart > end) add("old_page", "page", "maybe", `Old page until ${fmtDay(x.pageStart)}`, "The best months were on the old page", `${made} ${TEST}`);
    else if (x.pageStart > start) add("old_page", "page", "maybe", `Old page until ${fmtDay(x.pageStart)}`, "The page changed during the best months", `${made} So ${best} was on the old page until then. ${TEST}`);
    else if (laterTest) add("old_page", "page", "maybe", `Page test started ${fmtDay(laterTest.from)}`, "Part of the best months may have been on the old page", `${made} But a test against another page started on ${fmtDay(laterTest.from)}, so some visitors still saw another page. ${TEST}`);
    else add("old_page", "page", "fine", `Same page since ${fmtDay(x.pageStart)}`, "The best months were on the old page", `${made} That is before ${best}.`);
  } else add("old_page", "page", "unknown", "Old page in best months? Start day not known", "The best months were on the old page", "I don't know when this client's page was made.");

  const v1 = x.version.replace(/[()]/g, "").trim().toUpperCase() === "V1";
  const labelSaved = saved.filter((r) => r.item.key === "label");
  const programNotes = take(done(NOTE.program));
  const LABEL = "The label is (V1): no calendar and no deposit step";
  if (v1 && !x.frozen) add("label", "page", "found", "Label is (V1): no deposit step", LABEL, `With the (V1) label the page stops after the survey. If the label is a mistake, fix it in the Clients sheet.${x.now.d ? ` But ${plural(x.now.d, "new payer", "new payers")} paid in the last 30 days.` : ""}`, { whole: x.now.d === 0 });
  else if (labelSaved.length || programNotes.length) addDated("label", "page", "Program label", "The program label was switched", programNotes, labelSaved, ` Today the label is ${x.version || "empty"}.`);
  else if (v1) add("label", "page", "fine", "Label (V1), but the page is frozen", LABEL, "The label is (V1), but the page is frozen, so the label is not used.", { answer: TODAY });
  else if (blind) add("label", "page", "unknown", `Label was (V1)? ${x.version || "Empty"} today, history not saved`, LABEL, `The label is ${x.version || "empty"} today. Label changes before ${fmtDay(x.firstSave)} weren't saved, and I found no team note about a switch after ${best}.`);
  else add("label", "page", "fine", `Label ${x.version || "empty"}, no change`, LABEL, `The label is ${x.version || "empty"}, and no change is saved since ${best}.`);

  const running = x.tests.filter((t) => t.running);
  const testNames = (list: { name: string; from: string }[]) => list.slice(0, 2).map((t) => `"${clip(t.name, 60)}" started ${fmtDay(t.from)}.`).join(" ") + (list.length > 2 ? ` And ${list.length - 2} more.` : "");
  const liveTests = running.filter((t) => t.from > end && !tooNew(t.from));
  const ON = "A split test is on this client's page";
  if (liveTests.length) add("split_test", "page", "found", `Split test running since ${fmtDay(liveTests[0].from)}`, ON, `${testNames(liveTests)} Some visitors see another page.`);
  else if (running.length) add("split_test", "page", "maybe", `Split test running since ${fmtDay(running[0].from)}`, ON, `${testNames(running)} Some visitors see another page. ${running.every((t) => tooNew(t.from)) ? TOO_NEW : `It started before ${best} ended, so it is not new.`}`);
  else if (x.tests.length) add("split_test", "page", "maybe", `${plural(x.tests.length, "split test", "split tests")} from ${fmtDay(x.tests[0].from)}, paused now`, "A split test ran on this client's page", `${testNames(x.tests)} ${x.tests.length === 1 ? "It is" : "They are"} paused now. I don't have the day ${x.tests.length === 1 ? "it" : "they"} ended.`);
  else add("split_test", "page", "fine", "No split test of this client's own", "A split test ran on this client's page", `I found no test of this client's own page around or after ${best}. Tests that run on all clients' pages are not listed here.`, { answer: "Not one of their own." });

  const gaps = (x.issues ?? []).filter((i) => PAGE_GAP[i.code]).map((i) => PAGE_GAP[i.code](i));
  const PIECES = "The page is missing pieces (photos, Instagram, price)";
  if (gaps.length) add("missing_pieces", "page", "maybe", `Page: ${clip(gaps[0], 45)}${gaps.length > 1 ? ` (+${gaps.length - 1} more)` : ""}`, PIECES, `Today: ${gaps.join("; ")}. ${NEW}`);
  else if (f?.setup) add("missing_pieces", "page", "fine", f.setup.price ? "Page has photos, Instagram, price" : "Page has photos, Instagram; no price", PIECES, f.setup.price ? "Photos, Instagram and price are on the page today." : "Photos and Instagram are on the page today. The page shows no price.", { answer: TODAY });
  else add("missing_pieces", "page", "unknown", "Page missing pieces? No fresh data", PIECES, NO_CHECKUP);

  const priceSaved = saved.filter((r) => PRICE_KEY.test(r.item.key));
  const isPrice = (n: Note) => !NOTE.notPrice.test(n.note) || NOTE.priceWord.test(n.note);
  const priceNotes = take(done(NOTE.price).filter(isPrice));
  const priceToday = f?.setup ? ` Today the page says ${f.setup.price ? money(f.setup.price) : "no price"}${f.setup.offer ? `, offer "${clip(f.setup.offer, 40)}"` : ""}.` : "";
  const cliff = has("price_cliff") ? " Above $450 far fewer leads pay." : "";
  if (priceNotes.length || priceSaved.length) addDated("price", "page", "Price or offer", "The price or the offer changed", priceNotes, priceSaved, `${priceToday}${cliff}`);
  else if (cliff) add("price", "page", "maybe", `Price is over $450${f?.setup?.price ? `: ${money(f.setup.price)}` : ""}`, "The price is high", `${priceToday.trim()}${cliff} ${NEW}`);
  else add("price", "page", "unknown", `Price or offer changed? Ask ${coachName}`, "The price or the offer changed", `I found no team note about the price or the offer after ${best}.${priceToday}${lastDuring(done(NOTE.price, during).filter(isPrice))} Ask ${coach}.`);

  const ob = f?.onebox;
  const CAL = "Leads can't pick a time (calendar closed or full)";
  const fleetPick = f?.fleet?.pickRate ?? null;
  if (has("pick_none") && ob) add("calendar", "page", "found", `Only ${ob.picked30} of ${ob.leads30} leads picked a time`, "Almost no lead picks a time", `Only ${ob.picked30} of ${ob.leads30} page leads picked a time in 30 days. Open the page as a lead and look at the times.`, { whole: true });
  else if (ob && ob.leads30 >= 30 && ob.pickRate30 != null && (has("pick_low") || (fleetPick != null && ob.pickRate30 < fleetPick * 0.85))) add("calendar", "page", "maybe", `${whole(ob.pickRate30)} pick a time${fleetPick != null ? ` (others ${whole(fleetPick)})` : ""}`, "Few leads pick a time (few open times, or a weak page)", `${ob.pickRate30}% of the page leads picked a time.${others(fleetPick)} ${NEW}`);
  else if (ob && ob.leads30 >= 30 && ob.pickRate30 != null && fleetPick != null) add("calendar", "page", "fine", `${whole(ob.pickRate30)} pick a time (others ${whole(fleetPick)})`, CAL, `${ob.pickRate30}% of the page leads picked a time.${others(fleetPick)}`);
  else if (x.now.pageLeads >= 30) add("calendar", "page", "unknown", `${x.now.picks} of ${x.now.pageLeads} picked a time`, CAL, `${x.now.picks} of ${x.now.pageLeads} people on the page picked a time in 30 days. I have no number from other clients to compare. Open the page as a lead and look at the times.`);
  else add("calendar", "page", "unknown", "Hard to pick a time? Too few leads to tell", CAL, "There are too few page leads to tell. Open the page as a lead and look at the times.");

  const awayNotes = take(done(NOTE.away));
  const AWAY = "The open times are weeks away, or the client was away";
  if (awayNotes.length) { const v = dated(awayNotes); add("far_times", "page", v.kind === "open" ? "maybe" : "fine", notedShort("Away or full", v.kind, v.days[0]), v.kind === "open" ? "Team notes say the client was away or full" : AWAY, v.text, { answer: ANSWER[v.kind] }); }
  else add("far_times", "page", "unknown", `Open times far away, or time off? Ask ${coachName}`, AWAY, `Open the page as a lead and look at the first open times.${lastDuring(done(NOTE.away, during))} Ask ${coach} if the client was away.`);

  const busyNotes = take(done(NOTE.busy));
  const BUSY = "We changed how full the calendar looks (Look Busy)";
  const fleetBusy = LOOK_BUSY_OFF >= lateFrom ? ` On ${fmtDay(LOOK_BUSY_OFF)} we switched Look Busy off on every funnel calendar that had it on, so more open times show. Ask ${coach} if this client had it on.` : "";
  /* That switch was the same for every client, so when the other clients' rate held,
     it is not what made this one fall. */
  const othersHeld = !!x.others && x.others.then.l >= 200 && x.others.now.l >= 200 && rate(x.others.now.d, x.others.now.l) > rate(x.others.then.d, x.others.then.l) * 0.8;
  const othersDown = !!x.others && rate(x.others.now.d, x.others.now.l) < rate(x.others.then.d, x.others.then.l);
  const HELD = ` It was the same for every client, and the other clients' rate ${othersDown ? "fell only a little" : "did not fall"}.`;
  if (busyNotes.length) { const v = dated(busyNotes); add("look_busy", "page", v.kind === "open" || (fleetBusy && !tooNew(LOOK_BUSY_OFF) && !othersHeld) ? "maybe" : "fine", v.kind !== "open" && fleetBusy ? `Look Busy off for all since ${fmtDay(LOOK_BUSY_OFF)}` : notedShort("Look Busy", v.kind, v.days[0]), BUSY, `${v.text}${fleetBusy}${fleetBusy && othersHeld ? HELD : ""}`, { answer: ANSWER[v.kind] }); }
  else if (fleetBusy && othersHeld) add("look_busy", "page", "fine", `Look Busy off for all since ${fmtDay(LOOK_BUSY_OFF)}`, BUSY, `${fleetBusy.trim()}${lastDuring(done(NOTE.busy, during))}${HELD}`, { answer: "Yes, for every client." });
  else if (fleetBusy) add("look_busy", "page", tooNew(LOOK_BUSY_OFF) ? "unknown" : "maybe", `Look Busy off since ${fmtDay(LOOK_BUSY_OFF)}`, BUSY, `${fleetBusy.trim()}${lastDuring(done(NOTE.busy, during))}`);
  else add("look_busy", "page", "unknown", `Look Busy changed? Ask ${coachName}`, BUSY, `I found no team note about it after ${best}.${lastDuring(done(NOTE.busy, during))} Ask ${coach}.`);

  const FREE = "Free booking is on, so the page asks for no deposit";
  if (x.freeBooking && x.now.d === 0) add("free_booking", "page", "found", "Free booking on, nobody paid", FREE, "Leads can book without paying, and nobody paid in 30 days.", { whole: true });
  else if (x.freeBooking) add("free_booking", "page", "maybe", "Free booking is on", FREE, `Leads can book without paying. But ${plural(x.now.d, "new payer", "new payers")} paid in the last 30 days. ${NEW}`);
  else add("free_booking", "page", "fine", "Free booking is off", FREE, "Free booking is off today. The page asks for the deposit.", { answer: TODAY });

  const depositNotes = take(done(NOTE.deposit));
  const settings = saved.filter((r) => !isOurChange(r.item) && !PRICE_KEY.test(r.item.key) && !["budget", "label", "instagram", "reviews", "engine", "test"].includes(r.item.key));
  const SETTING = "A setting changed (deposit amount, address, phone, pixel)";
  if (depositNotes.length || settings.length) addDated("settings", "page", "A setting", SETTING, depositNotes, settings);
  else if (blind) add("settings", "page", "unknown", `Setting changed? Before ${fmtDay(x.firstSave)} not saved`, SETTING, `I see no saved change ${sinceSave}, and no team note about the deposit amount after ${best}. Changes before that date weren't saved.`);
  else add("settings", "page", "fine", "No setting changed", SETTING, `Nothing changed since ${best}.`);

  add("page_slow", "page", "unknown", "Page slow? Test on a phone", "The page was down or slow", "I have no speed history. Open the page on a phone and time it.");

  const rating = f?.setup?.reviewsRating;
  const reviewCount = f?.setup?.reviewsCount;
  if (rating != null) add("reviews", "page", rating < 4.5 ? "maybe" : "fine", `Google: ${rating} stars${reviewCount != null ? `, ${plural(reviewCount, "review", "reviews")}` : ""}`, "Bad Google reviews", `Google shows ${rating} stars${reviewCount != null ? ` from ${plural(reviewCount, "review", "reviews")}` : ""} on the page today.${rating < 4.5 ? ` ${NEW}` : ""}`, { answer: TODAY });
  else add("reviews", "page", "unknown", f?.setup ? "Bad Google reviews? None on the page" : "Bad Google reviews? No fresh data", "Bad Google reviews", f?.setup ? "The page shows no Google reviews. Look the client up on Google." : NO_CHECKUP);

  /* ── The pay step ──────────────────────────────────────────────────── */
  const versions = `${f?.version ?? ""} ${x.version}`.toUpperCase();
  const v3 = /V3/.test(versions);
  const v23 = !v3 && /V2/.test(versions);
  const CHARGE = "The pay page can't charge (no product)";
  if (has("cant_charge")) add("cant_charge", "pay", "found", "Pay page has no product", CHARGE, `The pay page has no product today, so nobody can pay there.${x.now.d ? ` But ${plural(x.now.d, "new payer", "new payers")} paid in the last 30 days.` : ""}`, { whole: x.now.d === 0 });
  else if (v3 && f?.setup?.canCharge) add("cant_charge", "pay", "fine", "Pay page has a product", CHARGE, "The pay page has a product today.", { answer: TODAY });
  else add("cant_charge", "pay", "unknown", f?.setup ? "Pay box missing? Look at the pay page" : "Pay box missing? No fresh data", CHARGE, f?.setup ? "I only check this for V3 pages. Open the pay page and look for the pay box." : NO_CHECKUP);

  const PAY = "The pay page is broken or slow, or cards are declined";
  const sincePay = x.lastDeposit ? daysBetween(x.today, x.lastDeposit) : null;
  const paid = `${plural(x.now.d, "new payer", "new payers")} in the last 30 days${x.lastDeposit ? `, the last on ${fmtDay(x.lastDeposit)}` : ""}.`;
  if (x.now.d > 0 && sincePay != null && sincePay <= 7) add("pay_broken", "pay", "fine", `Pay page worked on ${fmtDay(x.lastDeposit as string)}`, PAY, `${paid} So it worked then. I can't see payments that failed, or how fast the page is.`, { answer: "Not that I can see." });
  else if (x.now.d > 0) add("pay_broken", "pay", "unknown", `Last payment ${x.lastDeposit ? fmtDay(x.lastDeposit) : "in the last 30 days"}: test the pay page`, PAY, `${paid} Nothing shows it has worked since then. Make a real test payment on the page.`);
  else add("pay_broken", "pay", "unknown", `No payment ${x.lastDeposit ? `since ${fmtDay(x.lastDeposit)}` : "in 30 days"}: test the pay page`, PAY, `Nobody paid in 30 days${x.lastDeposit ? ` (the last new deposit was on ${fmtDay(x.lastDeposit)})` : ""}, so I can't be sure the pay page works. Make a real test payment on the page.`);

  const LINK = "The pay link we send goes to an old page";
  if (x.payLink === "other") add("pay_link", "pay", "maybe", x.pageStart && x.pageStart > end ? "Pay link: old page, same as in best months" : "Pay link goes to an old page", LINK, `The pay link in our copy goes to an old GHL page, not to today's page. ${x.pageStart && x.pageStart > end ? `In ${best} it went to the old page too, so this is likely not what changed.` : NEW}`);
  else if (x.payLink === "none") add("pay_link", "pay", "unknown", "Pay link wrong? None saved in our copy", LINK, "No pay link is saved in our copy. Look at the link inside the client's GHL account.");
  else add("pay_link", "pay", "fine", "Our copy of the pay link: today's page", LINK, "Our copy of the link points to today's page. I can't see the link inside the client's GHL account.", { answer: "Not in our copy." });

  add("pay_methods", "pay", "unknown", x.payLink === "other" ? "Apple Pay, PayPal: not checked (old page)" : "Apple Pay or PayPal broken? Test on a phone", "Apple Pay or PayPal doesn't work", x.payLink === "other" ? "The pay link goes to an old page. I didn't check Apple Pay and PayPal there." : "I can't make a test payment. Open the pay page on an iPhone and try Apple Pay.");
  add("pay_other_time", "pay", "unknown", "Wrong time on the pay page? Read chats", "The pay page shows another time than the chat agreed", "Only the chats show this.");
  add("scam_fear", "pay", "unknown", "Leads afraid to pay online? Read chats", "Leads are afraid to pay online", "Only the chats show this.");
  add("not_counted", "pay", "unknown", "Payments missing from our list? Compare with Fanbasis", "Leads paid, but the payment isn't in our list (or is under another name)", "Compare the payments in Fanbasis with the Deposits tab.");
  add("no_deposit_visit", "pay", "unknown", "Visits booked with no deposit? Check the calendar", "Leads get a confirmed visit without paying", "Look at the client's calendar for confirmed visits with no deposit.");

  /* ── The AI and texts ──────────────────────────────────────────────── */
  const NO_AI = "This client is on V2.3, which has no AI follow-up.";
  const k = f?.kills;
  const CALLS = "Someone calls the leads, and the call switches the AI off";
  if (v23) add("calls", "ai", "unknown", "Calls stop the AI? No AI on V2.3", CALLS, NO_AI);
  else if (k && k.callQualified >= 20 && has("call_kill")) add("calls", "ai", "maybe", `Calls stopped the AI for ${k.callDead} of ${k.callQualified} leads`, CALLS, `${k.callDead} of ${k.callQualified} leads lost all follow-up after a call in 14 days. I can't hear the calls or see who called. ${NEW}`);
  else if (k && k.callQualified >= 20) add("calls", "ai", "fine", k.callDead ? `Calls rarely stop the AI: ${k.callDead} of ${k.callQualified}` : `Calls did not stop the AI (0 of ${k.callQualified})`, CALLS, `${k.callDead} of ${plural(k.callQualified, "lead", "leads")} lost the follow-up after a call in 14 days.`, { answer: k.callDead ? "Rarely, in the last 14 days." : "Not in the last 14 days." });
  else add("calls", "ai", "unknown", k ? "Calls stop the AI? Too few leads to tell" : "Calls stop the AI? No fresh data", CALLS, k ? `There are too few leads to tell (${k.callDead} of ${k.callQualified} in 14 days).` : NO_CHECKUP);

  const TEXTS = "Someone texts the leads by hand, and that switches the AI off";
  if (v23) add("own_texts", "ai", "unknown", "Hand texts stop the AI? No AI on V2.3", TEXTS, NO_AI);
  else if (k && k.textQualified >= 20 && has("text_kill")) add("own_texts", "ai", "maybe", `Hand texts stopped the AI for ${k.textDead} of ${k.textQualified} leads`, TEXTS, `${k.textDead} of ${k.textQualified} leads lost the AI after a text typed by hand in 14 days. I can't see who typed it: the client, the staff or our team. ${NEW}`);
  else if (k && k.textQualified >= 20) add("own_texts", "ai", "fine", k.textDead ? `Hand texts rarely stop the AI: ${k.textDead} of ${k.textQualified}` : `Hand texts did not stop the AI (0 of ${k.textQualified})`, TEXTS, `${k.textDead} of ${plural(k.textQualified, "lead", "leads")} lost the AI after a text typed by hand in 14 days.`, { answer: k.textDead ? "Rarely, in the last 14 days." : "Not in the last 14 days." });
  else add("own_texts", "ai", "unknown", k ? "Hand texts stop the AI? Too few leads to tell" : "Hand texts stop the AI? No fresh data", TEXTS, k ? `There are too few leads to tell (${k.textDead} of ${k.textQualified} in 14 days).` : NO_CHECKUP);

  const ai = f?.ai;
  /* No rows at all means our copy of the account is empty, not that nothing happened. */
  const noSync = !!ai && ai.leads === 0;
  const NO_SYNC = "Our copy of this client's account has no leads, so I can't check. The sync may be off.";
  const FEW = "There are too few leads to tell.";
  const AI_OFF = "The AI is switched off on many leads";
  if (v23) add("ai_off", "ai", "unknown", "AI off on many leads? No AI on V2.3", AI_OFF, NO_AI);
  else if (noSync) add("ai_off", "ai", "unknown", "AI off on many leads? Account not synced", AI_OFF, NO_SYNC);
  else if (ai?.aiOffPct != null && ai.leads >= 30) {
    const text = `The AI is off on ${ai.aiOffPct}% of the leads from the last 30 days.${others(x.fleetAiOffPct)}`;
    const aiOffShort = `AI off for ${whole(ai.aiOffPct)} of leads${x.fleetAiOffPct != null ? ` (others ${whole(x.fleetAiOffPct)})` : ""}`;
    if (ai.aiOffPct >= 25 || (x.fleetAiOffPct != null && ai.aiOffPct >= 10 && ai.aiOffPct > x.fleetAiOffPct * 1.5)) add("ai_off", "ai", "maybe", aiOffShort, AI_OFF, `${text} ${NEW}`);
    else if (x.fleetAiOffPct == null && ai.aiOffPct >= 10) add("ai_off", "ai", "unknown", aiOffShort, AI_OFF, `${text} I have no number from other clients to compare.`);
    else add("ai_off", "ai", "fine", aiOffShort, AI_OFF, text, { answer: ai.aiOffPct ? "Not on many." : "Not in the last 30 days." });
  } else add("ai_off", "ai", "unknown", ai ? "AI off on many leads? Too few leads to tell" : "AI off on many leads? No fresh data", AI_OFF, ai ? FEW : NO_CHECKUP);

  const offNotes = take(after.filter((n) => did(NOTE.off, n.note)));
  const OFF = "The AI, reminders or follow-ups were turned off for this client";
  if (offNotes.length) { const v = dated(offNotes); add("asked_off", "ai", v.kind === "open" ? "found" : "fine", notedShort("AI or follow-ups off", v.kind, v.days[0]), v.kind === "open" ? "A team note says the AI, reminders or follow-ups were turned off" : OFF, v.text, { answer: ANSWER[v.kind] }); }
  else add("asked_off", "ai", "unknown", `AI or reminders turned off? Ask ${coachName}`, OFF, `I found no team note about it after ${best}.${lastDuring(during.filter((n) => did(NOTE.off, n.note)))} Ask ${coach}.`);

  const WAIT = "Leads ask a question and nobody answers";
  if (v23) add("no_answer", "ai", "unknown", "Leads left waiting? No AI on V2.3", WAIT, NO_AI);
  else if (noSync) add("no_answer", "ai", "unknown", "Leads left waiting? Account not synced", WAIT, NO_SYNC);
  else if (ai && ai.hotWaiting >= 2) add("no_answer", "ai", "maybe", `${ai.hotWaiting} leads wait for an answer`, WAIT, `${ai.hotWaiting} leads asked something in the past week and are still waiting. I can't see past weeks.`);
  else if (ai) add("no_answer", "ai", "fine", ai.hotWaiting === 0 ? "No lead waits for an answer" : "1 lead waits for an answer", WAIT, `${ai.hotWaiting === 0 ? "No lead is" : "1 lead is"} waiting for an answer. I can't see past weeks.`, { answer: "Not now." });
  else add("no_answer", "ai", "unknown", "Leads left waiting? No fresh data", WAIT, NO_CHECKUP);

  const REACH = "New leads don't reach the AI";
  if (v23) add("not_reaching_ai", "ai", "unknown", "Leads reach the AI? No AI on V2.3", REACH, NO_AI);
  else if (noSync) add("not_reaching_ai", "ai", "unknown", "Leads reach the AI? Account not synced", REACH, NO_SYNC);
  else if (ai && ob && ob.leads30 >= 30) {
    const text = `${ai.leads} leads from the last 30 days are in the account with the AI tag. The page brought ${ob.leads30}.`;
    if (ai.leads < ob.leads30 * 0.7) add("not_reaching_ai", "ai", "maybe", `AI got only ${ai.leads} leads; the page brought ${ob.leads30}`, REACH, `${text} ${NEW}`);
    else add("not_reaching_ai", "ai", "fine", `AI got ${ai.leads} leads; the page brought ${ob.leads30}`, REACH, text);
  } else add("not_reaching_ai", "ai", "unknown", ai ? "Leads reach the AI? Too few to tell" : "Leads reach the AI? No fresh data", REACH, ai ? FEW : NO_CHECKUP);

  const BOT = "The AI bot isn't linked or doesn't answer";
  const OFFERS = "The AI rarely gets to the offer";
  if (v23) { add("bot_broken", "ai", "unknown", "AI bot broken? No AI on V2.3", BOT, NO_AI); add("few_offers", "ai", "unknown", "AI makes few offers? No AI on V2.3", OFFERS, NO_AI); }
  else if (!noSync && ai?.offerPct != null && ai.leads >= 30) {
    const text = `The AI made an offer to ${ai.offerPct}% of the leads from the last 30 days.${others(x.fleetOfferPct)}`;
    const offerShort = `AI offer to ${whole(ai.offerPct)} of leads${x.fleetOfferPct != null ? ` (others ${whole(x.fleetOfferPct)})` : ""}`;
    if (ai.offerPct < 3) add("bot_broken", "ai", "maybe", `AI made an offer to only ${whole(ai.offerPct)} of leads`, "The AI bot may not be working", `${text} Look at this client's account in CloseBot.`);
    else add("bot_broken", "ai", "fine", "AI bot answers", BOT, `The AI made an offer to ${ai.offerPct}% of the leads from the last 30 days, so it answers.`);
    if (x.fleetOfferPct == null) add("few_offers", "ai", "unknown", offerShort, OFFERS, `${text} I have no number from other clients to compare.`);
    else if (ai.offerPct < x.fleetOfferPct * 0.7) add("few_offers", "ai", "maybe", offerShort, "The AI gets to the offer less often than for other clients", `${text} ${NEW}`);
    else add("few_offers", "ai", "fine", offerShort, OFFERS, text, { answer: ai.offerPct >= x.fleetOfferPct ? "Not less than for others." : "A bit less than for others." });
  } else {
    add("bot_broken", "ai", "unknown", noSync ? "AI bot broken? Account not synced" : "AI bot broken? Check CloseBot", BOT, noSync ? NO_SYNC : "Look at this client's account in CloseBot.");
    add("few_offers", "ai", "unknown", noSync ? "AI makes few offers? Account not synced" : ai ? "AI makes few offers? Too few leads to tell" : "AI makes few offers? No fresh data", OFFERS, noSync ? NO_SYNC : ai ? FEW : NO_CHECKUP);
  }

  /* "Engaged" in the check-up is every lead past "new, nothing started": it also
     counts leads who only booked on the page and leads with the AI off. So a normal
     number can't show that leads answer; only a low one says something. */
  const CHATS = "Many leads never get past the first step";
  if (v23) add("few_chats", "ai", "unknown", "Leads stuck at \"new\"? No AI on V2.3", CHATS, NO_AI);
  else if (!noSync && ai?.engagedPct != null && f?.fleet?.engagedPct != null && ai.leads >= 30) {
    const text = `${ai.engagedPct}% of the leads are past "new, nothing started".${others(f.fleet.engagedPct)} This also counts leads who only booked on the page, and leads with the AI off.`;
    if (has("engaged_low") || ai.engagedPct < f.fleet.engagedPct * 0.85) add("few_chats", "ai", "maybe", `${whole(ai.engagedPct)} of leads moved past "new" (others ${whole(f.fleet.engagedPct)})`, CHATS, `${text} ${NEW}`);
    else add("few_chats", "ai", "unknown", `${whole(ai.engagedPct)} of leads moved past "new" (others ${whole(f.fleet.engagedPct)})`, CHATS, `${text} So it can't show how many leads answer the texts.`);
  } else add("few_chats", "ai", "unknown", noSync ? "Leads stuck at \"new\"? Account not synced" : ai ? "Leads stuck at \"new\"? Too few leads to tell" : "Leads stuck at \"new\"? No fresh data", CHATS, noSync ? NO_SYNC : ai ? FEW : NO_CHECKUP);

  if (x.depAskSince) add("dep_ask_test", "ai", tooNew(x.depAskSince) ? "unknown" : "maybe", `AI text test since ${fmtDay(x.depAskSince)}`, "A test changed what the AI says after a lead picks a time", `Since ${fmtDay(x.depAskSince)}, for half of this client's leads who pick a time, the AI's first answer names the time and sends the pay link. The result isn't known yet.`);
  add("no_deposit_ask", "ai", "unknown", v23 ? "Deposit asked by text? No AI on V2.3" : "Deposit asked by text? Read 10 chats", "After a lead picks a time, the texts don't ask for the deposit", v23 ? NO_AI : "Only the chats show this. Read 10 chats of leads who picked a time and didn't pay.");
  add("texts_blocked", "ai", "unknown", "Texts not arriving? Check GHL", "Our texts don't reach the leads (number not registered, filter, daily limit)", "I can't see if texts arrive. Look for failed messages in the client's GHL account.");
  add("wrong_price_told", "ai", "unknown", "Wrong price told? Read chats", "Leads ask the price and get no price, or a wrong one", "Only the chats show this.");
  add("script_changed", "ai", "unknown", "AI script changed? Ask the team", "The AI script or the automatic texts changed", `Most clients share one AI script, and the automatic texts are set in each account. I can't see changes there. Ask the team what changed after ${best}.`);
  add("stop_dnd", "ai", "unknown", "Many leads say STOP? Check GHL", "Many leads say STOP", "Look at the DND contacts in the client's GHL account.");
  add("meta_ai", "ai", "unknown", "Facebook's own AI answers? Check the Page inbox", "Facebook's own AI answers leads on the client's Page", "Look at the Facebook Page inbox.");
  add("call_back", "ai", "unknown", "Leads call back, nobody answers? Ask the client", "Leads call the number back and nobody picks up", "Ask the client who answers that number.");

  /* ── The artist ────────────────────────────────────────────────────── */
  add("own_deposits", "artist", "unknown", "Deposits by Zelle or cash? Ask the client", "The client takes deposits outside the page (Zelle, cash), or books with no deposit", "I can't see payments made outside the page. Ask the client, or read the chats.");
  add("own_phone", "artist", "unknown", "Leads moved to another phone? Ask the client", "The client or the staff move leads to their own phone", "I can't see that phone. Ask the client.");
  add("slow_or_away", "artist", "unknown", `Client slow or fully booked? Ask ${coachName}`, "The client is slow to answer, or fully booked", `Ask ${coach}.`);

  const unhappy = take(after.filter((n) => NOTE.unhappy.test(n.note)));
  if (unhappy.length) add("unhappy", "artist", "maybe", `Unhappy or wants to stop: team note ${fmtDay(unhappy[unhappy.length - 1].date)}`, "A team note says the client is unhappy or wants to stop", `${unhappy.slice(-2).map(quote).join(" ")} This may come from the fall. It may not be the reason.`);
  else add("unhappy", "artist", "unknown", `Client unhappy or wants to cancel? Ask ${coachName}`, "The client is unhappy or wants to cancel, and stopped answering the leads", `I found no team note about it after ${best}. Ask ${coach}.`);

  add("price_talk", "artist", "unknown", "Another price told to leads? Read chats", "The client tells leads another price than the page", "Only the chats and calls show this.");
  add("competitor", "artist", "unknown", "New artist nearby? Ask the client", "A new or cheaper artist opened nearby, or people in the city saw the ad too many times", "This is not in our data. Ask the client.");
  add("account_moved", "artist", "unknown", "Account rebuilt? Ask the team", "The account was rebuilt or moved to a new one", `Ask the team if the setup was redone after ${best}.`);
  add("team_changed", "artist", "unknown", "Coach or buyer changed? Old names not saved", "Another coach or media buyer handles this client now", `Today the coach is ${x.ads?.coach || "not on file"} and the media buyer is ${x.ads?.buyer || "not on file"}. Past names aren't saved.`);

  /* ── Timing, counting and chance ───────────────────────────────────── */
  const ALL = "All clients fell together (time of year, or a change for everyone)";
  if (x.others && x.others.then.l >= 200 && x.others.now.l >= 200) {
    const was = rate(x.others.then.d, x.others.then.l), is = rate(x.others.now.d, x.others.now.l);
    const othersShort = `${pctText(x.others.then.d, x.others.then.l)} then, ${pctText(x.others.now.d, x.others.now.l)} now`;
    const text = `The same ${x.others.clients} other clients: ${pctText(x.others.then.d, x.others.then.l)} in ${best}, ${pctText(x.others.now.d, x.others.now.l)} in the last 30 days.`;
    if (is <= was * 0.8) add("everyone", "numbers", "found", `Other clients fell too: ${othersShort}`, "The other clients' rate fell too (time of year, or a change for everyone)", `${text} So part of this fall is not about this client.`);
    else if (is >= was) add("everyone", "numbers", "fine", `Other clients: ${othersShort}`, ALL, `${text} So the others did not fall.`);
    else add("everyone", "numbers", "fine", `Other clients: ${othersShort}`, ALL, `${text} So the others fell a little, much less than this client.`, { answer: "Not much." });
  } else add("everyone", "numbers", "unknown", "Other clients fell too? Too few to compare", ALL, "Too few other clients were live in both periods.");

  /* The usual rate: full months before the best two, from June on (April and May are
     partial and thinly recorded), without the client's first month (often partial). */
  const firstMonth = Object.keys(x.months).filter((m) => x.months[m].l > 0).sort()[0];
  const sum = (keys: string[]) => keys.reduce((a, m) => ({ l: a.l + x.months[m].l, d: a.d + x.months[m].d }), { l: 0, d: 0 });
  const beforeKeys = Object.keys(x.months).filter((m) => m < x.peak.from && m >= "2026-06" && m !== firstMonth).sort();
  const cutMonth = addDays(x.today, -30).slice(0, 7);
  const afterKeys = Object.keys(x.months).filter((m) => m > x.peak.to && m < cutMonth).sort();
  const usual = sum(beforeKeys);
  const later = sum(afterKeys);
  const usualKnown = usual.l >= 40 && !(x.earlyDepositsMissing && usual.d === 0);
  const names = (keys: string[]) => keys.map((m) => monthLabel(m)).join(", ");
  const laterText = later.l >= 30 ? ` In the full months after (${names(afterKeys)}): ${pctText(later.d, later.l)} (${later.d} of ${later.l} leads).` : "";

  const p = chanceOfSoFew(x.peak, x.now.l, x.now.d);
  const pUsual = usualKnown && usual.d > 0 ? chanceOfSoFew(usual, x.now.l, x.now.d) : null;
  const oneIn = (v: number) => Math.max(2, Math.round(1 / v)).toLocaleString("en-US");
  const LUCK = "Only luck: the numbers are small";
  if (p > 0.001 || (pUsual != null && pUsual > 0.01)) {
    const vsBest = p > 0.001 ? `about 1 time in ${oneIn(p)}` : "less than 1 time in 1,000";
    add("chance", "numbers", "maybe", p > 0.001 ? `Can be luck: 1 chance in ${oneIn(p)}` : `Can be luck: 1 chance in ${oneIn(pUsual as number)} from earlier months`, LUCK, `By luck alone, a fall this big from the best months happens ${vsBest} for one client.${pUsual != null && pUsual > 0.001 ? ` From the months before them it is about 1 time in ${oneIn(pUsual)}.` : ""} We check about 100 clients and compare with their best months, so a few are on this list only by luck.`);
  } else add("chance", "numbers", "fine", "Luck: less than 1 chance in 1,000", LUCK, "By luck alone, a fall this big happens less than 1 time in 1,000.", { answer: "Not likely." });

  const USUAL = "The best months were much better than this client's usual";
  if (usualKnown) {
    const usualShort = `Before best months: ${pctText(usual.d, usual.l)} (best ${pctText(x.peak.d, x.peak.l)})`;
    const text = `In the full months before (${names(beforeKeys)}) the rate was ${pctText(usual.d, usual.l)} (${usual.d} of ${usual.l} leads). In ${best}: ${pctText(x.peak.d, x.peak.l)}.${laterText} Now: ${pctText(x.now.d, x.now.l)}.`;
    if (rate(usual.d, usual.l) <= peakRate * 0.7) add("lucky_peak", "numbers", "maybe", usualShort, USUAL, `${text} So part of the fall can be a return to the rate from before.`);
    else add("lucky_peak", "numbers", "fine", usualShort, USUAL, `${text} So the best months were not far from the rate before them.`);
  } else add("lucky_peak", "numbers", "unknown", "Best months unusually good? Too few months before", USUAL, `There are too few full months before ${best} to compare.${laterText} We always pick the 2 best months, so the months after them often look lower.`);

  const NEWEST = "The newest leads didn't have time to pay yet";
  if (f?.sheetLeads30 && f.sheetLeads7 != null && f.sheetLeads30 >= 20) {
    const text = `${f.sheetLeads7} of the ${f.sheetLeads30} lead rows from the last 30 days came in the last 7 days.`;
    if (f.sheetLeads7 >= f.sheetLeads30 * 0.4) add("too_new", "numbers", "maybe", `${f.sheetLeads7} of ${f.sheetLeads30} leads are under 7 days old`, NEWEST, `${text} Some leads pay days later.`);
    else add("too_new", "numbers", "fine", `${f.sheetLeads7} of ${f.sheetLeads30} leads are under 7 days old`, NEWEST, text);
  } else add("too_new", "numbers", "unknown", f ? "Leads too new to pay? Too few to tell" : "Leads too new to pay? No fresh data", NEWEST, f ? FEW : NO_CHECKUP);

  add("counting", "numbers", "fine", "Counting: same rules then and now", "We count leads or deposits another way now", "The rules are the same in both periods: each person counts once as a lead and once as a payer.");
  add("local_event", "numbers", "unknown", "Storm or holiday? Not in our data", "A storm, a holiday or a big event in the client's city", "This is not in our data.");

  /* Team notes after the best months that fit none of the lines above, so no dated
     note is hidden. Not a cause by itself: the short note doesn't count it. */
  const rest = after.filter((n) => !used.has(`${n.date}|${n.note}`) && !NOTE.status.test(n.note));
  if (rest.length) add("other_notes", "numbers", "maybe", plural(rest.length, "other team note", "other team notes"), "Other team notes after the best months", `${rest.slice(-2).map(quote).join(" ")}${rest.length > 2 ? ` And ${rest.length - 2} more.` : ""}`);

  return out;
}

/* The short "why I think it fell" note above the list: the few words of what was
   found, or "Not known yet". "Likely" needs a cause that by itself stops most deposits. */
export type FellWhy = { text: string; sure: "likely" | "maybe" | "chance" | "unknown" };

/* Ads that stop bring fewer leads; they don't make a smaller part of the leads pay.
   So they are never named as the reason, only added as "Fewer leads". */
const LEADS_ONLY = new Set(["ads_off", "ad_account"]);

export function fellWhy(causes: Cause[]): FellWhy {
  const list = causes.filter((c) => c.id !== "other_notes");
  const found = list.filter((c) => c.state === "found" && !LEADS_ONLY.has(c.id));
  const fewer = list.find((c) => c.state === "found" && LEADS_ONLY.has(c.id));
  const whole = found.filter((c) => c.whole);
  const shown = [...whole, ...found.filter((c) => !c.whole)].slice(0, 3);
  const chance = list.find((c) => c.id === "chance" && c.state === "maybe");
  const fewerText = fewer ? ` Fewer leads: ${fewer.short.replace(/: fewer leads$/, "")}.` : "";
  if (!shown.length) return { text: `Not known yet.${chance ? ` ${chance.short}.` : ""}${fewerText}`, sure: chance ? "chance" : "unknown" };
  const more = found.length - shown.length;
  return {
    text: `${shown.map((c) => c.short).join(". ")}.${more > 0 ? ` And ${more} more.` : ""}${fewerText}`,
    sure: whole.length && !chance ? "likely" : "maybe",
  };
}
