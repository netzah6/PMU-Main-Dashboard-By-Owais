import { createServiceClient } from "@/lib/supabase/server";
import { BASE, CALL_WINDOWS, LOC, LOCAL_OK_FROM, LOCAL_OK_TO, getJson, token, zoneForPhone } from "@/lib/power-dialer";
import { ZONE_TZ } from "@/lib/dialer-areacodes";

/* Dialer activity (owner 11/15/2026: "keep track of everything she's doing —
   what time she calls, and if the system works properly").

   Two sources, both from GHL itself:
     • the agency account's call log (conversations/messages/export,
       channel Call) — every outbound call by the chosen person: when (PT),
       how it ended (status + seconds), whether it was inside our two call
       windows and inside the lead's own 9 AM–8 PM;
     • per lead the dashboard sent to that person's Power Dialer workflow
       (table dialer_sends), that lead's conversation after the send: call 1,
       call 2, and the no-answer text (matched by its exact wording), plus
       whether the lead wrote or called back.
   "Talked" = a call of 60 seconds or more (the dialer's pick-up rule). */

export type DialerRange = "today" | "yesterday" | "7d";
type Msg = { id?: string; contactId?: string; direction?: string; status?: string; messageType?: string; dateAdded?: string; body?: string; userId?: string; to?: string; meta?: { call?: { duration?: number; status?: string } } };

export type DayStats = {
  ymd: string; calls: number; first: string | null; last: string | null;
  talked: number; noAnswer: number; failed: number;
  outsideWindow: number; outsideLocal: number;
  /** PT hour (0–23) → calls that hour. */
  hours: Record<number, number>;
};
export type CallStep = { at: string; status: string; seconds: number | null; byOther?: string };
export type LeadRun = {
  contactId: string; name: string; list: string | null; sentAt: string;
  call1: CallStep | null; call2: CallStep | null;
  text: { at: string; status: string } | null;
  replied: boolean;
  result: "talked" | "done" | "in_progress" | "waiting";
  problems: string[];
};
export type DialerActivity = {
  caller: { id: string; name: string };
  range: DialerRange; from: string; to: string;
  days: DayStats[];
  leads: LeadRun[];
  health: { sent: number; called: number; done: number; talked: number; textsSent: number; textsFailed: number; callsFailed: number; replied: number };
  builtAt: string;
};

const TALK_SECONDS = 60;
const CALL_TYPES = new Set(["TYPE_CALL", "TYPE_CAMPAIGN_CALL"]);
const PT = "America/Los_Angeles";

/** "YYYY-MM-DD" of a moment, in Pacific time. */
export function ptYmd(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: PT, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
/** Minutes after midnight, Pacific. */
export function ptMinutes(d: Date): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: PT, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return Number(p.hour) * 60 + Number(p.minute);
}
/** The moment a Pacific calendar day starts (handles PST/PDT). */
export function ptDayStart(ymd: string): Date {
  for (const off of ["-08:00", "-07:00"]) {
    const d = new Date(`${ymd}T00:00:00${off}`);
    if (ptYmd(d) === ymd && ptMinutes(d) === 0) return d;
  }
  return new Date(`${ymd}T08:00:00Z`);
}
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const inWindow = (d: Date) => { const m = ptMinutes(d); return CALL_WINDOWS.some((w) => m >= toMin(w.start) && m < toMin(w.end)); };
function leadLocalOk(phone: string | undefined, d: Date): boolean | null {
  const zone = phone ? zoneForPhone(phone) : undefined;
  const tz = zone ? ZONE_TZ[zone] : undefined;
  if (!tz) return null;
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(d));
  return h >= LOCAL_OK_FROM && h < LOCAL_OK_TO;
}
const norm = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const isFailed = (s?: string) => /fail|undeliver|error/i.test(s ?? "");

export function rangeBounds(range: DialerRange, now = new Date()): { from: Date; to: Date } {
  const today = ptDayStart(ptYmd(now));
  if (range === "today") return { from: today, to: now };
  const dayBefore = (d: Date) => ptDayStart(ptYmd(new Date(d.getTime() - 12 * 3_600_000)));
  if (range === "yesterday") return { from: dayBefore(today), to: today };
  let from = today;
  for (let i = 0; i < 6; i++) from = dayBefore(from);
  return { from, to: now };
}

/** Every outbound call in the agency account since `from`, newest first. */
async function callsSince(H: Record<string, string>, from: Date): Promise<Msg[]> {
  const out: Msg[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 60; page++) {
    const r: { messages?: Msg[]; nextCursor?: string } =
      await getJson(`${BASE}/conversations/messages/export?locationId=${LOC}&channel=Call&limit=100${cursor ? `&cursor=${cursor}` : ""}`, H);
    const ms = r.messages ?? [];
    out.push(...ms);
    const oldest = ms.length ? Date.parse(ms[ms.length - 1].dateAdded ?? "") : 0;
    if (!ms.length || !r.nextCursor || oldest < from.getTime()) break;
    cursor = r.nextCursor;
  }
  return out.filter((m) => m.dateAdded && Date.parse(m.dateAdded) >= from.getTime());
}

/** One lead's messages (all conversations), newest first. */
async function leadMessages(H: Record<string, string>, contactId: string): Promise<Msg[]> {
  const cs = await getJson<{ conversations?: Array<{ id: string }> }>(`${BASE}/conversations/search?locationId=${LOC}&contactId=${contactId}`, H);
  const out: Msg[] = [];
  for (const c of (cs.conversations ?? []).slice(0, 3)) {
    const r = await getJson<{ messages?: { messages?: Msg[] } }>(`${BASE}/conversations/${c.id}/messages?limit=100`, H);
    out.push(...(r.messages?.messages ?? []));
  }
  return out.sort((a, b) => String(b.dateAdded).localeCompare(String(a.dateAdded)));
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const res: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; res[k] = await fn(items[k]); }
  }));
  return res;
}

const cache = new Map<string, { at: number; data: DialerActivity }>();

export async function buildDialerActivity(caller: { id: string; name: string }, range: DialerRange, users: Array<{ id: string; name: string }>, force = false): Promise<DialerActivity> {
  const key = `${caller.id}:${range}`;
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < 60_000) return hit.data;

  const { from, to } = rangeBounds(range);
  const H = await token();
  const nameOf = new Map(users.map((u) => [u.id, u.name]));

  // ── Her calls, per Pacific day ──
  const calls = (await callsSince(H, from)).filter((m) =>
    m.userId === caller.id && m.direction === "outbound" && CALL_TYPES.has(m.messageType ?? "") && Date.parse(m.dateAdded!) < to.getTime());
  const byDay = new Map<string, DayStats>();
  for (const m of [...calls].reverse()) {
    const d = new Date(m.dateAdded!);
    const ymd = ptYmd(d);
    const s = byDay.get(ymd) ?? { ymd, calls: 0, first: null, last: null, talked: 0, noAnswer: 0, failed: 0, outsideWindow: 0, outsideLocal: 0, hours: {} };
    const secs = m.meta?.call?.duration ?? 0;
    const status = m.meta?.call?.status ?? m.status ?? "";
    s.calls++;
    s.first ??= m.dateAdded!; s.last = m.dateAdded!;
    if (secs >= TALK_SECONDS) s.talked++;
    else if (isFailed(status)) s.failed++;
    else s.noAnswer++;
    if (!inWindow(d)) s.outsideWindow++;
    if (leadLocalOk(m.to, d) === false) s.outsideLocal++;
    const h = Math.floor(ptMinutes(d) / 60);
    s.hours[h] = (s.hours[h] ?? 0) + 1;
    byDay.set(ymd, s);
  }
  const days = [...byDay.values()].sort((a, b) => b.ymd.localeCompare(a.ymd));

  // ── Leads sent to her dialer in this range ──
  const { data: sendRows } = await createServiceClient().from("dialer_sends")
    .select("contact_id, contact_name, list, sms_text, sent_at")
    .eq("caller_id", caller.id).gte("sent_at", from.toISOString()).lt("sent_at", to.toISOString())
    .order("sent_at", { ascending: false }).limit(400);
  const latest = new Map<string, { contact_id: string; contact_name: string | null; list: string | null; sms_text: string | null; sent_at: string }>();
  for (const r of (sendRows ?? []) as Array<{ contact_id: string; contact_name: string | null; list: string | null; sms_text: string | null; sent_at: string }>) {
    if (!latest.has(r.contact_id)) latest.set(r.contact_id, r);
  }
  const sends = [...latest.values()].slice(0, 150);
  const leads = await pool(sends, 4, async (s): Promise<LeadRun> => {
    const sentMs = Date.parse(s.sent_at);
    let msgs: Msg[] = [];
    try { msgs = (await leadMessages(H, s.contact_id)).filter((m) => m.dateAdded && Date.parse(m.dateAdded) >= sentMs); } catch { /* shown as waiting */ }
    const asc = [...msgs].reverse();
    const outCalls = asc.filter((m) => m.direction === "outbound" && CALL_TYPES.has(m.messageType ?? ""));
    const step = (m: Msg | undefined): CallStep | null => m ? {
      at: m.dateAdded!, status: m.meta?.call?.status ?? m.status ?? "", seconds: m.meta?.call?.duration ?? null,
      ...(m.userId && m.userId !== caller.id ? { byOther: nameOf.get(m.userId) ?? "someone else" } : {}),
    } : null;
    const want = norm(s.sms_text);
    const textMsg = want ? asc.find((m) => m.direction === "outbound" && m.messageType === "TYPE_SMS" && norm(m.body) === want) : undefined;
    const replied = asc.some((m) => m.direction === "inbound" && (m.messageType === "TYPE_SMS" || CALL_TYPES.has(m.messageType ?? "")));
    const talked = outCalls.some((m) => (m.meta?.call?.duration ?? 0) >= TALK_SECONDS)
      || asc.some((m) => m.direction === "inbound" && CALL_TYPES.has(m.messageType ?? "") && (m.meta?.call?.duration ?? 0) >= TALK_SECONDS);
    const call1 = step(outCalls[0]), call2 = step(outCalls[1]);
    const text = textMsg ? { at: textMsg.dateAdded!, status: textMsg.status ?? "" } : null;
    const problems: string[] = [];
    if (outCalls.some((m) => isFailed(m.meta?.call?.status ?? m.status))) problems.push("A call failed to connect");
    if (text && isFailed(text.status)) problems.push("Text did not deliver");
    if (text && outCalls.length < 2 && !talked) problems.push("Text sent before 2 calls");
    if (!outCalls.length && Date.now() - sentMs > 24 * 3_600_000) problems.push("Not called after 24 hours");
    const result: LeadRun["result"] = talked ? "talked" : outCalls.length >= 2 && text ? "done" : outCalls.length || text ? "in_progress" : "waiting";
    return { contactId: s.contact_id, name: s.contact_name ?? "(no name)", list: s.list, sentAt: s.sent_at, call1, call2, text, replied, result, problems };
  });

  const health = {
    sent: leads.length,
    called: leads.filter((l) => l.call1).length,
    done: leads.filter((l) => l.result === "done" || l.result === "talked").length,
    talked: leads.filter((l) => l.result === "talked").length,
    textsSent: leads.filter((l) => l.text && !isFailed(l.text.status)).length,
    textsFailed: leads.filter((l) => l.text && isFailed(l.text.status)).length,
    callsFailed: leads.filter((l) => l.problems.includes("A call failed to connect")).length,
    replied: leads.filter((l) => l.replied).length,
  };
  const data: DialerActivity = { caller, range, from: from.toISOString(), to: to.toISOString(), days, leads, health, builtAt: new Date().toISOString() };
  cache.set(key, { at: Date.now(), data });
  return data;
}
