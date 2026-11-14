import { getAppLocationToken } from "@/lib/ghl-app";
import { AREA_ZONE, ZONE_TZ } from "@/lib/dialer-areacodes";

// Power dialer (owner 11/14/2026): call lists for the setter and the closer,
// built LIVE from the 💸 SALES PIPELINE stages in the main GHL sub-account.
// Calling itself happens in GHL's own one-at-a-time dialer (Conversations →
// Manual Actions): "Start" enrolls the ticked contacts into that person's
// "Power Dialer" workflow, whose only step is a Manual Action → Call. Calls
// therefore go out from our GHL numbers, are recorded, and fire the existing
// call workflows exactly like a normal call.

const LOC = process.env.GHL_LOCATION_ID || "SfpNMJ5YU9lBkxss47lK";
const BASE = "https://services.leadconnectorhq.com";
const DEMO_CALENDARS = ["8N5925C8NxX7E0Cbw1oF", "RP7VFqOadCAfpKAfwM9F"];

export type DialerListKey = "discovery_noshow" | "demo_noshow" | "showed_no_close" | "followup" | "demo_no_update";

/** Which stage feeds each list, and whose list it is. Stage names are matched
 *  loosely (emoji + spacing stripped) so a renamed emoji doesn't break it. */
export const DIALER_LISTS: Record<DialerListKey, { label: string; side: "setter" | "closer"; stage: RegExp }> = {
  discovery_noshow: { label: "Discovery no-shows", side: "setter", stage: /discovery no show/ },
  demo_noshow: { label: "Demo no-shows", side: "setter", stage: /demo no show/ },
  showed_no_close: { label: "Showed, didn't close", side: "closer", stage: /showed didn t close/ },
  followup: { label: "Follow-up", side: "closer", stage: /didn t close follow up/ },
  demo_no_update: { label: "Demo done, no update", side: "closer", stage: /demo booked/ },
};

/** The two daily call windows, Pacific time (from 7,021 team calls in 2026:
 *  pick-up ≈24% from 9 AM–8 PM lead-local, 8–17% before 9 AM). */
export const CALL_WINDOWS = [
  { label: "Window 1", start: "10:00", end: "12:00" },
  { label: "Window 2", start: "14:30", end: "16:30" },
];
/** Lead-local hours we call in: 9:00 to 19:59. */
export const LOCAL_OK_FROM = 9;
export const LOCAL_OK_TO = 20;

export type DialerRow = {
  contactId: string;
  name: string;
  phone: string;
  email?: string;
  zone?: string;          // E/C/M/A/P/K/H
  tz?: string;
  stageAt?: string;       // when the card moved into this stage (ISO)
  demoAt?: string;        // demo appointment time, Pacific ("YYYY-MM-DD HH:MM:SS")
  assignedTo?: string;    // GHL user name
  lastCallAt?: string;    // last OUTBOUND call attempt (ISO), last 45 days
  lastTalkAt?: string;    // last call ≥60 s either way (ISO), last 45 days
  calls45?: number;       // outbound attempts in the last 45 days
  tags: string[];
};

export type DialerData = {
  lists: Record<DialerListKey, DialerRow[]>;
  users: Array<{ id: string; name: string }>;
  builtAt: string;
};

type Opp = {
  contactId?: string; assignedTo?: string; lastStageChangeAt?: string; status?: string;
  contact?: { id?: string; name?: string; phone?: string; email?: string; tags?: string[] };
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

export function zoneForPhone(phone: string): string | undefined {
  const d = phone.replace(/\D/g, "");
  if (d.length !== 11 || d[0] !== "1") return undefined;
  return AREA_ZONE[d.slice(1, 4)];
}

async function token(): Promise<Record<string, string>> {
  const { token, error } = await getAppLocationToken(LOC);
  if (!token) throw new Error(error || "Could not mint a GHL location token");
  return { Authorization: `Bearer ${token}`, Version: "2021-07-28", Accept: "application/json" };
}

async function getJson<T>(url: string, H: Record<string, string>): Promise<T> {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, { headers: H, cache: "no-store" });
    if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 1500 * (i + 1))); continue; }
    if (!r.ok) throw new Error(`GHL ${r.status} on ${url.split("?")[0].replace(BASE, "")}`);
    return (await r.json()) as T;
  }
  throw new Error("GHL rate limit");
}

async function stageOpps(H: Record<string, string>, pipelineId: string, stageId: string, max = 1500): Promise<Opp[]> {
  const out: Opp[] = [];
  let url: string | null = `${BASE}/opportunities/search?location_id=${LOC}&pipeline_id=${pipelineId}&pipeline_stage_id=${stageId}&status=open&limit=100`;
  while (url && out.length < max) {
    const r: { opportunities?: Opp[]; meta?: { nextPageUrl?: string | null } } = await getJson(url, H);
    out.push(...(r.opportunities ?? []));
    url = r.opportunities?.length ? (r.meta?.nextPageUrl ?? null) : null;
  }
  return out;
}

/** Recent call log (both directions) from the message export, newest first,
 *  stopping once calls are older than `days`. */
async function recentCalls(H: Record<string, string>, days: number) {
  const since = Date.now() - days * 86_400_000;
  const calls: Array<{ contactId: string; at: string; outbound: boolean; talked: boolean }> = [];
  let cursor: string | null = null;
  for (let page = 0; page < 40; page++) {
    const r: { messages?: Array<{ contactId?: string; dateAdded?: string; direction?: string; messageType?: string; status?: string; meta?: { call?: { duration?: number } } }>; nextCursor?: string } =
      await getJson(`${BASE}/conversations/messages/export?locationId=${LOC}&channel=Call&limit=100${cursor ? `&cursor=${cursor}` : ""}`, H);
    const ms = r.messages ?? [];
    for (const m of ms) {
      if (!m.contactId || !m.dateAdded) continue;
      if (m.messageType !== "TYPE_CALL" && m.messageType !== "TYPE_CAMPAIGN_CALL") continue;
      calls.push({ contactId: m.contactId, at: m.dateAdded, outbound: m.direction === "outbound", talked: (m.meta?.call?.duration ?? 0) >= 60 });
    }
    const oldest = ms.length ? Date.parse(ms[ms.length - 1].dateAdded ?? "") : 0;
    if (!ms.length || !r.nextCursor || oldest < since) break;
    cursor = r.nextCursor;
  }
  return calls.filter((c) => Date.parse(c.at) >= since);
}

/** Latest demo appointment per contact over the last 120 days (Pacific). */
async function demoTimes(H: Record<string, string>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const end = Date.now() + 30 * 86_400_000, start = Date.now() - 120 * 86_400_000;
  for (const cal of DEMO_CALENDARS) {
    const r = await getJson<{ events?: Array<{ contactId?: string; startTime?: string; appointmentStatus?: string; deleted?: boolean }> }>(
      `${BASE}/calendars/events?locationId=${LOC}&calendarId=${cal}&startTime=${start}&endTime=${end}`, H);
    for (const e of r.events ?? []) {
      if (!e.contactId || !e.startTime || e.deleted || /cancel|invalid/i.test(e.appointmentStatus ?? "")) continue;
      const prev = out.get(e.contactId);
      if (!prev || e.startTime > prev) out.set(e.contactId, e.startTime);
    }
  }
  return out;
}

/** "YYYY-MM-DD HH:MM:SS" in Pacific for now. */
function nowPacific(): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

let cache: { at: number; data: DialerData } | null = null;

export async function buildDialerData(force = false): Promise<DialerData> {
  if (!force && cache && Date.now() - cache.at < 5 * 60_000) return cache.data;
  const H = await token();
  const pipes = await getJson<{ pipelines?: Array<{ id: string; name: string; stages?: Array<{ id: string; name: string }> }> }>(`${BASE}/opportunities/pipelines?locationId=${LOC}`, H);
  const sales = (pipes.pipelines ?? []).find((p) => /sales pipeline/i.test(p.name));
  const journey = (pipes.pipelines ?? []).find((p) => /client journey/i.test(p.name));
  if (!sales) throw new Error("Sales pipeline not found in GHL");

  const usersRes = await getJson<{ users?: Array<{ id: string; name?: string; firstName?: string; lastName?: string }> }>(`${BASE}/users/?locationId=${LOC}`, H);
  const users = (usersRes.users ?? []).map((u) => ({ id: u.id, name: u.name || `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() }));
  const userName = new Map(users.map((u) => [u.id, u.name]));

  const stageFor = (re: RegExp) => (sales.stages ?? []).find((s) => re.test(norm(s.name)));
  const keys = Object.keys(DIALER_LISTS) as DialerListKey[];

  // Everyone with a Client Journey deal is already a client — never dial them
  // from a sales list (any stage there, including paused clients).
  const [oppsByKey, clientOpps, calls, demos] = await Promise.all([
    Promise.all(keys.map(async (k) => { const st = stageFor(DIALER_LISTS[k].stage); return st ? stageOpps(H, sales.id, st.id) : []; })),
    journey ? Promise.all((journey.stages ?? []).map((s) => stageOpps(H, journey.id, s.id, 3000))).then((x) => x.flat()) : Promise.resolve([] as Opp[]),
    recentCalls(H, 45),
    demoTimes(H),
  ]);
  const clients = new Set(clientOpps.map((o) => o.contactId).filter(Boolean) as string[]);

  const callInfo = new Map<string, { lastCallAt?: string; lastTalkAt?: string; calls45: number }>();
  for (const c of calls) {
    const x = callInfo.get(c.contactId) ?? { calls45: 0 };
    if (c.outbound) { x.calls45++; if (!x.lastCallAt || c.at > x.lastCallAt) x.lastCallAt = c.at; }
    if (c.talked && (!x.lastTalkAt || c.at > x.lastTalkAt)) x.lastTalkAt = c.at;
    callInfo.set(c.contactId, x);
  }

  const nowPT = nowPacific();
  const lists = {} as Record<DialerListKey, DialerRow[]>;
  keys.forEach((k, i) => {
    const seen = new Set<string>();
    const rows: DialerRow[] = [];
    for (const o of oppsByKey[i]) {
      const id = o.contactId || o.contact?.id;
      const phone = o.contact?.phone || "";
      if (!id || !phone || seen.has(id) || clients.has(id)) continue;
      const demoAt = demos.get(id);
      // "Demo done, no update" = the card still says Demo - Booked but the
      // demo time has already passed (the team didn't move the card).
      if (k === "demo_no_update" && (!demoAt || demoAt.replace("T", " ").slice(0, 19) >= nowPT)) continue;
      seen.add(id);
      const zone = zoneForPhone(phone);
      const ci = callInfo.get(id);
      rows.push({
        contactId: id,
        name: o.contact?.name || "(no name)",
        phone,
        email: o.contact?.email || undefined,
        zone,
        tz: zone ? ZONE_TZ[zone] : undefined,
        stageAt: o.lastStageChangeAt,
        demoAt: demoAt?.replace("T", " ").slice(0, 19),
        assignedTo: o.assignedTo ? userName.get(o.assignedTo) ?? undefined : undefined,
        lastCallAt: ci?.lastCallAt,
        lastTalkAt: ci?.lastTalkAt,
        calls45: ci?.calls45 ?? 0,
        tags: o.contact?.tags ?? [],
      });
    }
    lists[k] = rows;
  });

  const data: DialerData = { lists, users, builtAt: new Date().toISOString() };
  cache = { at: Date.now(), data };
  return data;
}

/** Enroll contacts into a GHL workflow (the person's Power Dialer workflow).
 *  One at a time with a small gap — GHL rate-limits bursts. */
export async function enrollInWorkflow(workflowId: string, contactIds: string[]): Promise<{ ok: string[]; failed: Array<{ id: string; error: string }> }> {
  const H = await token();
  const ok: string[] = [], failed: Array<{ id: string; error: string }> = [];
  for (const id of contactIds) {
    let done = false;
    for (let i = 0; i < 3 && !done; i++) {
      const r = await fetch(`${BASE}/contacts/${id}/workflow/${workflowId}`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: "{}" });
      if (r.status === 429) { await new Promise((x) => setTimeout(x, 1500 * (i + 1))); continue; }
      if (r.ok) ok.push(id); else failed.push({ id, error: `${r.status} ${(await r.text()).slice(0, 120)}` });
      done = true;
    }
    if (!done) failed.push({ id, error: "rate limit" });
    await new Promise((x) => setTimeout(x, 120));
  }
  return { ok, failed };
}
