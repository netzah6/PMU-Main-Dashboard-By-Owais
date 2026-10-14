import type { SupabaseClient } from "@supabase/supabase-js";
import { getAppLocationToken } from "@/lib/ghl-app";
import { buildSalesBoard, type Todo } from "@/lib/sales-board";

/* Real follow-up tracking for the Sales tab.

   The board used to count the sheet's "Follow up 1/2/3" columns, which the
   team never fills in — so every lead sat at 0/3 while the reps were in
   fact calling and texting. This reads the agency sub-account's GHL
   conversation log instead and applies the owner's definition
   (2026-10-14):

     • a call that lasted 30 seconds or more              = 1 follow-up
     • two call attempts in a row + a text message        = 1 follow-up

   Only activity AFTER the lead slipped (the missed call / the demo that
   didn't close) counts. Results are cached in sales_followups; a cron
   refreshes them hourly and the Sales tab has a "Refresh follow-ups" button. */

const MAIN_LOCATION = process.env.GHL_LOCATION_ID || "SfpNMJ5YU9lBkxss47lK";
const API = "https://services.leadconnectorhq.com";
const CONNECTED_SECS = 30;
const HOUR = 3600_000;

export type FuEvent = { at: string; kind: "call" | "attempts_text"; detail: string };
export type Msg = { t: number; dir: string; type: string; dur: number; body: string };

export const FOLLOW_UP_KINDS = new Set<Todo["kind"]>(["no_show", "cancelled", "didnt_book", "demo_no_show", "didnt_close", "booked"]);

/* A to-do needs follow-up tracking when the lead slipped and it's the
   rep's job to chase them. */
export function needsFollowUps(t: Todo): boolean {
  if (!FOLLOW_UP_KINDS.has(t.kind)) return false;
  if (t.kind === "booked") return t.demo?.outcome === "no_show";
  return true;
}

/* From when does activity count as a follow-up? The sheet's times are
   hand-typed and off by hours (timezone), so use day-sized margins:
   - the lead SHOWED (didn't close / didn't book): the meeting itself is in
     the log, so start a day later;
   - the lead did NOT show / cancelled: the "where are you?" calls at the
     appointment time are the first attempts, so start half a day before. */
export function followUpSince(t: Pick<Todo, "kind" | "when" | "demo">): number | null {
  const base = t.kind === "booked" ? t.demo?.when ?? t.when : t.when;
  if (!base) return null;
  const w = Date.parse(base);
  if (!Number.isFinite(w)) return null;
  return t.kind === "didnt_close" || t.kind === "didnt_book" ? w + 24 * HOUR : w - 12 * HOUR;
}

const fmtDur = (s: number) => (s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`);

/* The rule. Messages in any order; attempts and the text can come in either
   order within a streak. A connected call closes any streak. */
export function followUpEvents(msgs: Msg[], since: number): FuEvent[] {
  const out: FuEvent[] = [];
  let attempts: Msg[] = [];
  let text: Msg | null = null;
  const sorted = msgs.filter((m) => m.t >= since).sort((a, b) => a.t - b.t);
  for (const m of sorted) {
    const type = m.type.toUpperCase();
    if (type.includes("CALL")) {
      if (m.dur >= CONNECTED_SECS) {
        out.push({ at: new Date(m.t).toISOString(), kind: "call", detail: `${m.dir === "inbound" ? "Inbound call" : "Call"} · ${fmtDur(m.dur)}` });
        attempts = []; text = null;
        continue;
      }
      if (m.dir === "outbound") attempts.push(m);
    } else if (type === "TYPE_SMS" && m.dir === "outbound") {
      text = m;
    }
    if (attempts.length >= 2 && text) {
      const at = Math.max(attempts[attempts.length - 1].t, text.t);
      out.push({ at: new Date(at).toISOString(), kind: "attempts_text", detail: `${attempts.length} call attempts + text` });
      attempts = []; text = null;
    }
  }
  return out;
}

// ── GHL reads ────────────────────────────────────────────────────────────────
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function namesMatch(want: string, full: string): boolean {
  const words = norm(full).split(" ").filter(Boolean);
  const w = norm(want).split(" ").filter(Boolean);
  return w.length > 0 && w.every((x) => words.some((y) => y === x || (x.length === 1 && y.startsWith(x))));
}

/* GHL allows ~100 requests per 10 s per location; keep well under it. */
let lastStart = 0;
async function pace(): Promise<void> {
  const wait = lastStart + 120 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastStart = Date.now();
}
async function get<T>(url: string, token: string, version: string): Promise<T | null> {
  await pace();
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Version: version, Accept: "application/json" } }).catch(() => null);
  if (!r || !r.ok) return null;
  return (await r.json().catch(() => null)) as T | null;
}

type Contact = { id: string; firstName?: string; lastName?: string; contactName?: string };
type RawMsg = { dateAdded?: string; direction?: string; messageType?: string; type?: string; body?: string; meta?: { call?: { duration?: number; status?: string } } };

async function findContact(name: string, token: string): Promise<Contact | null> {
  const j = await get<{ contacts?: Contact[] }>(`${API}/contacts/?locationId=${MAIN_LOCATION}&query=${encodeURIComponent(name)}&limit=5`, token, "2021-07-28");
  const cs = j?.contacts ?? [];
  const label = (c: Contact) => c.contactName || `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim();
  return cs.find((c) => namesMatch(name, label(c))) ?? cs[0] ?? null;
}

async function loadMessages(contactId: string, token: string): Promise<Msg[]> {
  const cj = await get<{ conversations?: { id: string }[] }>(`${API}/conversations/search?locationId=${MAIN_LOCATION}&contactId=${contactId}`, token, "2021-04-15");
  const out: Msg[] = [];
  for (const c of (cj?.conversations ?? []).slice(0, 3)) {
    const mj = await get<{ messages?: { messages?: RawMsg[] } }>(`${API}/conversations/${c.id}/messages?limit=100`, token, "2021-07-28");
    for (const m of mj?.messages?.messages ?? []) {
      const t = Date.parse(String(m.dateAdded ?? ""));
      if (!Number.isFinite(t)) continue;
      out.push({ t, dir: String(m.direction ?? ""), type: String(m.messageType ?? m.type ?? ""), dur: Number(m.meta?.call?.duration ?? 0) || 0, body: String(m.body ?? "") });
    }
  }
  return out;
}

export type SyncResult = { checked: number; updated: number; skipped: number; errors: number; partial: boolean };

/* Refresh sales_followups for every lead on the to-do lists. Rows synced
   less than `maxAgeMin` ago are left alone (the cron runs hourly; the
   button forces everything). */
export async function syncSalesFollowUps(svc: SupabaseClient, opts: { maxAgeMin?: number; deadlineMs?: number } = {}): Promise<SyncResult> {
  const started = Date.now();
  const deadline = opts.deadlineMs ?? 240_000;
  const board = await buildSalesBoard(svc);
  const todos = [...board.setterTodos, ...board.closerTodos].filter(needsFollowUps);
  // One row per lead; the newest to-do decides the "since".
  const byName = new Map<string, Todo>();
  for (const t of todos) { const k = norm(t.name); const prev = byName.get(k); if (!prev || (t.when ?? "") > (prev.when ?? "")) byName.set(k, t); }

  const { data: existing } = await svc.from("sales_followups").select("name_key, synced_at, since").in("name_key", [...byName.keys()]);
  const fresh = new Map((existing ?? []).map((r) => [String(r.name_key), { synced: Date.parse(String(r.synced_at)), since: r.since ? Date.parse(String(r.since)) : null }]));
  const maxAge = (opts.maxAgeMin ?? 0) * 60_000;

  const { token, error } = await getAppLocationToken(MAIN_LOCATION);
  if (!token) throw new Error(error || "Could not mint a GHL location token");

  const res: SyncResult = { checked: 0, updated: 0, skipped: 0, errors: 0, partial: false };
  const queue = [...byName.entries()];
  let i = 0;
  const worker = async () => {
    while (i < queue.length) {
      if (Date.now() - started > deadline) { res.partial = true; return; }
      const [key, t] = queue[i++];
      const since = followUpSince(t);
      const had = fresh.get(key);
      if (had && maxAge > 0 && Date.now() - had.synced < maxAge && had.since === since) { res.skipped++; continue; }
      res.checked++;
      try {
        const c = await findContact(t.name, token);
        const msgs = c ? await loadMessages(c.id, token) : [];
        const events = c && since != null ? followUpEvents(msgs, since) : [];
        const { error: e } = await svc.from("sales_followups").upsert({
          name_key: key, name: t.name, contact_id: c?.id ?? null,
          contact_name: c ? (c.contactName || `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim()) : null,
          since: since != null ? new Date(since).toISOString() : null,
          follow_ups: events.length, events, last_at: events.length ? events[events.length - 1].at : null,
          error: c ? null : "not found in GHL", synced_at: new Date().toISOString(),
        });
        if (e) res.errors++; else res.updated++;
      } catch { res.errors++; }
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  return res;
}
