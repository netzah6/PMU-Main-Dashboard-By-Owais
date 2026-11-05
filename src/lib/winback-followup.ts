import { createServiceClient } from "@/lib/supabase/server";
import { isAutomatedMessage, sendConversationMessage, type PmuAccount, type ThreadMessage } from "@/lib/ghl-conversations";
import { PPS_RATE_LATER, PPS_RATE_NOW, winbackContext } from "@/lib/winback";
import {
  convSearch, currentClientReason, currentClients, firstNameOf, inSendWindow, isSequenceText, readContact, readThreads,
  type SequenceRow,
} from "@/lib/winback-sequence";

/* 💬 Follow-up for people who ANSWERED the win-back texts but did not come
   back yet (owner, 11/05/2026). Two texts, picked by what our own texts
   already told her:
     price  — she saw the $50 + $60 terms → the $60 rate is held until a date,
              then $80 (the owner must honor $80 after that date)
     spots  — no price shared yet → limited spots + the call link
   Spanish when she writes in Spanish. Nothing here runs by itself: the owner
   opens a preview in the Win-back tab, ticks who gets it and presses Send. */

type Svc = ReturnType<typeof createServiceClient>;
export type FollowupKind = "price" | "spots";
export type FollowupLang = "en" | "es";

const CALL_LINK = "www.pmu-bookings.com/nicolas-strategy-call";
export const FOLLOWUP_TEXT: Record<FollowupKind, Record<FollowupLang, string>> = {
  price: {
    en: `Hi {first}! Quick update: our pay-per-appointment rate stays at $${PPS_RATE_NOW} per client who shows up until {until}. After that it goes to $${PPS_RATE_LATER}. Nothing upfront and no monthly retainer. You only pay when you get paid. Even if you start later, want me to lock in your $${PPS_RATE_NOW}?`,
    es: `¡Hola {first}! Te cuento rápido: nuestra tarifa de pago por cita se queda en $${PPS_RATE_NOW} por cada clienta que llegue hasta el {until}. Después sube a $${PPS_RATE_LATER}. Nada por adelantado y sin mensualidad. Solo pagas cuando te pagan a ti. Aunque empieces más tarde, ¿quieres que te guarde tus $${PPS_RATE_NOW}?`,
  },
  spots: {
    en: `Hi {first}! Quick update: spots in our pay-per-appointment program are limited, and we're going to be full soon. I'd love to help you, even if you start later. Please schedule a call with me here: ${CALL_LINK}`,
    es: `¡Hola {first}! Te cuento rápido: los cupos en nuestro programa de pago por cita son limitados y pronto vamos a estar llenos. Me encantaría ayudarte, aunque empieces más tarde. Agenda una llamada conmigo aquí: ${CALL_LINK}`,
  },
};
export const followupText = (kind: FollowupKind, lang: FollowupLang, first: string, until: string) =>
  FOLLOWUP_TEXT[kind][lang].replace("{first}", first).replace("{until}", until);

/** "11/12" — a week from now (Pacific), the default day the $60 hold ends. */
export function defaultUntil(now = new Date()): string {
  return new Date(now.getTime() + 7 * 86_400_000).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", timeZone: "America/Los_Angeles" });
}
const validUntil = (s: unknown): string | null => (/^(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])$/.test(String(s ?? "").trim()) ? String(s).trim() : null);

// One of these follow-ups, whatever the name / date (also the hand-sent 11/05 wording).
const FOLLOWUP_RE = /quick update: (spots in our pay-per-appointment|we'll increase our pay-per-appointment|our pay-per-appointment rate stays)|te cuento rápido: (los cupos|nuestra tarifa|puedo guardarte)/i;
export const isFollowupText = (body: string) => FOLLOWUP_RE.test(body);
const SPANISH = /[¿¡ñ]|\b(hola|gracias|pero|estoy|puedes|tengo|cuando|ahorita|hermosa|porque|por\s?que|también|mañana)\b/i;
const PRICE_SHOWN = /\$\s?60\b/;
const DEADLINE_GIVEN = /\$\s?80\b/;
const CALL_BOOKED = /strategy call .{0,40}scheduled for|reminder that your strategy call/i;
const REPEAT_DAYS = 14;
const FRESH_DAYS = 3;
const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", timeZone: "America/Los_Angeles" });

export type FollowupPerson = {
  sheetRow: number; name: string; business: string | null; contactId: string; first: string;
  kind: FollowupKind; lang: FollowupLang; text: string;
  herLast: string; herLastAt: string;
  /** Something the owner should look at first — these start unticked. */
  warn: string | null;
};
export type FollowupSkipped = { sheetRow: number; name: string; why: string };
type Verdict = { person: FollowupPerson } | { skip: string } | null;

/* One person, read live. null = she never answered (not a follow-up case). */
async function evaluate(acct: PmuAccount, r: SequenceRow, until: string, now: Date): Promise<Verdict> {
  const startedAt = Date.parse(r.batch_started_at!);
  const convs = await convSearch(acct, r.contact_id!);
  if (!convs.length) return null;
  const msgs = await readThreads(acct, convs, 100);
  const since = msgs.filter((m) => Date.parse(m.dateAdded!) > startedAt);
  // A copy of our own day-7 email can come back as "inbound" — not her words.
  const isHers = (m: ThreadMessage) => m.direction === "inbound" && !isSequenceText(m.body);
  const hers = since.filter(isHers);
  if (!hers.length) return null;
  const ctx = winbackContext(r, msgs);
  if (ctx.stage === "declined") return { skip: "Said no — mark her ✖ Not now" };
  const ours = since.filter((m) => m.direction === "outbound");
  const again = ours.filter((m) => isFollowupText(m.body)).pop();
  if (again && now.getTime() - Date.parse(again.dateAdded!) < REPEAT_DAYS * 86_400_000) return { skip: `Already got this follow-up on ${shortDate(again.dateAdded!)}` };
  // The last thing a person wrote (workflow blasts don't count).
  const real = since.filter((m) => isHers(m) || (m.direction === "outbound" && !isAutomatedMessage(m)));
  const last = real[real.length - 1];
  if (last && isHers(last)) return { skip: `She wrote last (${shortDate(last.dateAdded!)}) — answer her from the chat first` };
  const c = await readContact(acct, r.contact_id!);
  if (!c) return { skip: "Contact is gone from GHL" };
  if (c.smsDnd || !c.phone) return { skip: c.phone ? "Do not disturb is on" : "No phone number" };
  if (!inSendWindow(now, c.timezone)) return { skip: "Outside 9am–7pm her time — try again later" };

  const kind: FollowupKind = ours.some((m) => PRICE_SHOWN.test(m.body)) ? "price" : "spots";
  const lang: FollowupLang = hers.some((m) => SPANISH.test(m.body)) ? "es" : "en";
  const first = firstNameOf(c.firstName, r.owner_name);
  const told = kind === "price" ? ours.find((m) => DEADLINE_GIVEN.test(m.body)) : undefined;
  const call = ours.filter((m) => CALL_BOOKED.test(m.body)).pop();
  const warn =
    told ? `We already gave her a date for the $${PPS_RATE_LATER} rate on ${shortDate(told.dateAdded!)} — read the chat so the dates match`
    : call && now.getTime() - Date.parse(call.dateAdded!) < REPEAT_DAYS * 86_400_000 ? `A call was booked (${shortDate(call.dateAdded!)}) — check before texting`
    : last && now.getTime() - Date.parse(last.dateAdded!) < FRESH_DAYS * 86_400_000 ? `A teammate wrote to her on ${shortDate(last.dateAdded!)} — maybe too soon`
    : null;
  const herLast = hers[hers.length - 1];
  return { person: {
    sheetRow: r.sheet_row, name: r.owner_name, business: r.business, contactId: r.contact_id!, first,
    kind, lang, text: followupText(kind, lang, first, until),
    herLast: herLast.body.replace(/\s+/g, " ").slice(0, 160), herLastAt: herLast.dateAdded!, warn,
  } };
}

export type FollowupResult = {
  dryRun: boolean; until: string; texts: Record<FollowupKind, string>;
  people: FollowupPerson[]; skipped: FollowupSkipped[];
  sent: number; failed: Array<{ name: string; error: string }>;
  /** Set when the current-client check could not run (the list is still shown). */
  notice: string | null;
};

/* dryRun (default): who would get which text, and who is left out and why.
   Real run: only the sheetRows the owner ticked, each re-read right before
   its text goes out — anyone who changed meanwhile is skipped, not sent. */
export async function runFollowup(acct: PmuAccount, opts: { dryRun?: boolean; until?: string; sheetRows?: number[]; svc?: Svc; now?: Date } = {}): Promise<FollowupResult> {
  const svc = opts.svc ?? createServiceClient();
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun !== false;
  const until = validUntil(opts.until) ?? defaultUntil(now);
  const { data, error } = await svc.from("winback_contacts").select("*").eq("active", true).is("outcome", null)
    .not("batch_no", "is", null).not("contact_id", "is", null).order("sheet_row");
  if (error) throw new Error(error.message);
  let rows = ((data ?? []) as SequenceRow[]).filter((r) => r.stopped_reason !== "opted_out" && r.stopped_reason !== "current_client");
  if (!dryRun) { const only = new Set(opts.sheetRows ?? []); rows = rows.filter((r) => only.has(r.sheet_row)); }

  let notice: string | null = null;
  const cc = await currentClients(svc).catch((e) => { notice = `Couldn't check who is a current client (${e instanceof Error ? e.message : e}) — look for clients who already came back before sending`; return null; });
  if (!dryRun && !cc) throw new Error(notice ?? "Couldn't check current clients — nothing was sent");

  const people: FollowupPerson[] = [];
  const skipped: FollowupSkipped[] = [];
  const failed: FollowupResult["failed"] = [];
  let sent = 0;
  const one = async (r: SequenceRow) => {
    const client = cc ? currentClientReason(r, cc) : null;
    if (client) { skipped.push({ sheetRow: r.sheet_row, name: r.owner_name, why: `${client} — mark her 🎉 Came back` }); return; }
    let v: Verdict;
    try { v = await evaluate(acct, r, until, now); }
    catch (e) { skipped.push({ sheetRow: r.sheet_row, name: r.owner_name, why: `Couldn't read her chat: ${e instanceof Error ? e.message : e}` }); return; }
    if (!v) { if (!dryRun) skipped.push({ sheetRow: r.sheet_row, name: r.owner_name, why: "No reply of hers found" }); return; }
    if ("skip" in v) { skipped.push({ sheetRow: r.sheet_row, name: r.owner_name, why: v.skip }); return; }
    if (!dryRun) {
      const res = await sendConversationMessage(acct, { contactId: v.person.contactId, message: v.person.text, channel: "SMS" });
      if (!res.ok) { failed.push({ name: r.owner_name, error: res.error ?? "Send failed" }); return; }
      sent++;
    }
    people.push(v.person);
  };
  // Previews read three chats at a time; real sends go one by one.
  const lanes = dryRun ? 3 : 1;
  let next = 0;
  await Promise.all(Array.from({ length: lanes }, async () => { while (next < rows.length) await one(rows[next++]); }));
  people.sort((a, b) => a.sheetRow - b.sheetRow);
  skipped.sort((a, b) => a.sheetRow - b.sheetRow);
  return { dryRun, until, texts: { price: FOLLOWUP_TEXT.price.en.replace("{until}", until), spots: FOLLOWUP_TEXT.spots.en }, people, skipped, sent, failed, notice };
}
