import type { SupabaseClient } from "@supabase/supabase-js";
import { textOwner } from "@/lib/agent-notify";

/* ── Instagram engagement (owner, 10/30/2026) ───────────────────────────────
   "Follow each client that signs up with us + all our existing clients, then
   engage with them — stories, posts, reels, comments — so we stay on their
   minds and they follow us back. Without getting banned."

   How: once a day, at a different hour each day (and one day off a week), the
   dashboard files ONE Mac Mini task. The Mini opens Instagram in its own
   Chrome (signed in as @pmubookings.ondemand, same home Wi-Fi as the owner's
   phone) and, for a handful of clients, like a person would: follows them if
   we don't yet, watches their stories, likes the newest post, and writes a
   comment idea for it. Comments wait on the Instagram tab for approval
   (owner: approve comments for the first weeks) and are posted on the next
   run. The pace starts at 5 clients a day and grows over 4 weeks.

   Instagram's own "Try again later" / action-blocked screen stops the run and
   switches the whole thing OFF until the owner turns it back on — losing the
   account is the one thing that must not happen.

   Clients: every one-box funnel's Instagram link (new sign-ups land
   automatically); status engage / vip / paused / blocked + a note decides who
   the Mini visits. Task cards: agent_proposals, conversation_id
   'igengage:<iso time>', location 'instagram' (the worker's prompt switches
   on it). The Mini's structured report comes back in finish's `data`. */

type Svc = SupabaseClient;
const now = () => new Date().toISOString();

export const IGE_PREFIX = "igengage:";
export const IGE_LOCATION = "instagram"; // not a GHL sub-account — the worker's prompt switches on it
export const SETTINGS_KEY = "ig_engage";
export const OUR_HANDLE = "pmubookings.ondemand";

export type EngageStatus = "engage" | "vip" | "paused" | "blocked";
export type EngageSettings = {
  enabled: boolean;
  startedAt: string | null;       // first switched on — the warm-up counts from here
  approveComments: boolean;       // comments wait for a human yes (default on)
  pausedReason?: string | null;   // set when Instagram pushed back and the dashboard switched it off
  lastQueuedDay?: string | null;  // YYYY-MM-DD (Pacific) of the last daily run
};
const DEFAULTS: EngageSettings = { enabled: false, startedAt: null, approveComments: true, pausedReason: null, lastQueuedDay: null };

export const isIgEngageTask = (conversationId: string | null | undefined) => !!conversationId?.startsWith(IGE_PREFIX);

export function usernameFromLink(link: unknown): string | null {
  const s = String(link ?? "").trim();
  if (!s) return null;
  const m = s.match(/instagram\.com\/(?!p\/|reel\/|stories\/|explore\/)([A-Za-z0-9._]{1,30})/i) ?? s.match(/^@?([A-Za-z0-9._]{1,30})$/);
  const u = m?.[1]?.replace(/\.+$/, "").toLowerCase();
  return u && u !== OUR_HANDLE ? u : null;
}

export async function getSettings(svc: Svc): Promise<EngageSettings> {
  const { data } = await svc.from("app_settings").select("value").eq("key", SETTINGS_KEY).maybeSingle();
  return { ...DEFAULTS, ...((data?.value ?? {}) as Partial<EngageSettings>) };
}
export async function saveSettings(svc: Svc, patch: Partial<EngageSettings>, by: string): Promise<EngageSettings> {
  const next = { ...(await getSettings(svc)), ...patch };
  if (next.enabled && !next.startedAt) next.startedAt = now();
  await svc.from("app_settings").upsert({ key: SETTINGS_KEY, value: next, updated_by: by, updated_at: now() });
  return next;
}

/* Warm-up: a new pattern on an account is what gets it flagged, so the daily
   number grows slowly. Week 1 = 5 clients, 2 = 8, 3 = 12, then 15. */
export function warmupWeek(startedAt: string | null): number {
  if (!startedAt) return 1;
  return Math.floor((Date.now() - Date.parse(startedAt)) / (7 * 86_400_000)) + 1;
}
export function dailyQuota(startedAt: string | null): number {
  return [5, 8, 12][warmupWeek(startedAt) - 1] ?? 15;
}
// VIP clients get a visit every 3 days, everyone else once a week.
const REVISIT_DAYS: Record<EngageStatus, number> = { vip: 3, engage: 7, paused: Infinity, blocked: Infinity };

/* ── Clients: one row per one-box Instagram link ─────────────────────────── */
type OneboxRow = { slug: string; client_name: string | null; status: string; config: { igLink?: string } | null; extras: { igFeed?: { profile?: { username?: string } } } | null };
export async function syncClients(svc: Svc): Promise<{ added: number }> {
  const [{ data: boxes }, { data: have }] = await Promise.all([
    svc.from("onebox_clients").select("slug, client_name, status, config, extras"),
    svc.from("ig_engage_clients").select("username, slug"),
  ]);
  const known = new Set(((have ?? []) as Array<{ username: string }>).map((r) => r.username));
  const rows: Array<Record<string, unknown>> = [];
  for (const b of (boxes ?? []) as OneboxRow[]) {
    const u = usernameFromLink(b.config?.igLink) ?? usernameFromLink(b.extras?.igFeed?.profile?.username);
    if (!u || known.has(u)) continue;
    known.add(u);
    rows.push({ username: u, slug: b.slug, client_name: b.client_name, status: b.status === "live" ? "engage" : "paused", updated_by: "sync" });
  }
  if (rows.length) await svc.from("ig_engage_clients").upsert(rows, { onConflict: "username", ignoreDuplicates: true });
  return { added: rows.length };
}

export type EngageClient = {
  username: string; slug: string | null; client_name: string | null; status: EngageStatus; note: string | null;
  followed_at: string | null; follows_us: boolean | null; last_engaged_at: string | null; last_action: string | null; last_error: string | null;
};

/* Who the Mini visits today: never-followed first (newest sign-ups get
   followed within days), then whoever waited longest past their revisit. */
export function pickDue(clients: EngageClient[], n: number, must: Set<string> = new Set()): EngageClient[] {
  const t = Date.now();
  const due = clients.filter((c) => {
    if (c.status !== "engage" && c.status !== "vip") return false;
    if (must.has(c.username)) return true;
    if (!c.followed_at || !c.last_engaged_at) return true;
    return t - Date.parse(c.last_engaged_at) >= REVISIT_DAYS[c.status] * 86_400_000;
  });
  const score = (c: EngageClient) => (must.has(c.username) ? -2e13 : 0) + (c.followed_at ? 0 : -1e13) + (c.last_engaged_at ? Date.parse(c.last_engaged_at) : 0) - (c.status === "vip" ? 86_400_000 : 0);
  return due.sort((a, b) => score(a) - score(b)).slice(0, Math.max(n, must.size));
}

/* ── The daily run ─────────────────────────────────────────────────────────
   One run a day at an hour picked from the date (8 AM–4 PM Pacific, a
   different hour each day), never on the week's rest day — a bot posts at
   the same minute every day, a person doesn't. */
const pacificDay = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }); // YYYY-MM-DD
const pacificHour = (d = new Date()) => Number(d.toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false })) % 24;
function seeded(day: string, salt: string): number {
  let h = 2166136261;
  for (const ch of day + salt) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0) / 4294967296;
}
export function plannedHour(day: string): number { return 8 + Math.floor(seeded(day, "hour") * 9); } // 8..16 Pacific
export function isRestDay(day: string): boolean {
  // One rest day per ISO-ish week: weekday index chosen from the week's Monday.
  const d = new Date(`${day}T12:00:00Z`);
  const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const rest = Math.floor(seeded(monday.toISOString().slice(0, 10), "rest") * 7);
  return (d.getUTCDay() + 6) % 7 === rest;
}
export function nextRunText(s: EngageSettings): string {
  if (!s.enabled) return "Off";
  for (let i = 0; i < 8; i++) {
    const d = new Date(Date.now() + i * 86_400_000);
    const day = pacificDay(d);
    if (isRestDay(day) || day === s.lastQueuedDay) continue;
    if (i === 0 && pacificHour() > plannedHour(day)) continue;
    const label = i === 0 ? "Today" : new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "2-digit", day: "2-digit", timeZone: "UTC" });
    const h = plannedHour(day);
    return `${label} around ${h > 12 ? h - 12 : h} ${h >= 12 ? "PM" : "AM"} Pacific`;
  }
  return "—";
}

export type QueueOutcome = { queued: boolean; why?: string; taskId?: string; clients?: number };

export async function cronTick(svc: Svc): Promise<QueueOutcome> {
  const s = await getSettings(svc);
  if (!s.enabled) return { queued: false, why: "off" };
  const day = pacificDay();
  if (s.lastQueuedDay === day) return { queued: false, why: "already ran today" };
  if (isRestDay(day)) return { queued: false, why: "rest day" };
  if (pacificHour() < plannedHour(day)) return { queued: false, why: `waiting for ${plannedHour(day)}:00 Pacific` };
  return queueRun(svc, "daily schedule");
}

export async function queueRun(svc: Svc, by: string): Promise<QueueOutcome> {
  const s = await getSettings(svc);
  if (!s.enabled) return { queued: false, why: "Instagram engagement is switched off" };
  const { data: open } = await svc.from("agent_proposals").select("id").like("conversation_id", `${IGE_PREFIX}%`).in("status", ["queued_browser", "running"]).limit(1).maybeSingle();
  if (open) return { queued: false, why: "a run is already waiting or running", taskId: (open as { id: string }).id };
  await syncClients(svc);

  const [{ data: cl }, { data: appr }] = await Promise.all([
    svc.from("ig_engage_clients").select("*"),
    svc.from("ig_engage_actions").select("id, username, kind, text, post_url").eq("status", "approved").order("decided_at").limit(30),
  ]);
  const clients = (cl ?? []) as EngageClient[];
  const active = new Set(clients.filter((c) => c.status === "engage" || c.status === "vip").map((c) => c.username));
  const approved = ((appr ?? []) as Array<{ id: string; username: string; kind: string; text: string; post_url: string | null }>).filter((a) => active.has(a.username));
  const must = new Set(approved.map((a) => a.username));
  const batch = pickDue(clients, dailyQuota(s.startedAt), must);
  if (!batch.length) return { queued: false, why: "nobody is due today" };

  const ts = now();
  const lines = batch.map((c, i) => {
    const posts = approved.filter((a) => a.username === c.username);
    const todo = [
      c.followed_at ? "we already follow them (check; follow if not)" : "FOLLOW them (we don't yet)",
      "watch their stories if they have any (let each play a few seconds) and tap the heart on one",
      "like their newest post or reel",
      ...posts.map((a) => `POST this approved comment (action id ${a.id}) on ${a.post_url ?? "their newest post"}: """${a.text}"""`),
      s.approveComments ? "write ONE comment idea for their newest post (do NOT post it) — it goes to the owner for approval" : "write and POST one short comment on their newest post",
    ];
    return `${i + 1}. @${c.username}${c.client_name ? ` (${c.client_name})` : ""} — ${todo.join("; ")}`;
  });
  const plan = [
    "Open https://www.instagram.com/ and confirm you are signed in as @pmubookings.ondemand. Scroll the home feed for about 20 seconds first, like a person opening the app.",
    ...lines,
    "Finish by scrolling the home feed for about 15 seconds, then report.",
  ];
  const { data: ins, error } = await svc.from("agent_proposals").insert({
    conversation_id: `${IGE_PREFIX}${ts}`, message_id: `igengage#${ts.slice(0, 16)}`, contact_id: null,
    contact_name: "Instagram engagement", channel: null,
    client_message: `Daily Instagram engagement — ${batch.length} client${batch.length === 1 ? "" : "s"} (warm-up week ${warmupWeek(s.startedAt)}). Queued by ${by}.`,
    summary: `Instagram: engage with ${batch.length} client${batch.length === 1 ? "" : "s"}`,
    action_type: "account_change", proposed_reply: null,
    action_detail: JSON.stringify({ usernames: batch.map((c) => c.username), approved: approved.map((a) => a.id), approveComments: s.approveComments }),
    action_plan: plan.map((what) => ({ type: "manual", what })),
    location_id: IGE_LOCATION, status: "queued_browser", decided_by: `${by} (Instagram)`, decided_at: ts, executed_at: ts,
    result: "⏳ Waiting for the AI Agent (Instagram)", browser_attempts: 0,
  }).select("id").maybeSingle();
  if (error || !ins) return { queued: false, why: error?.message ?? "insert failed" };
  await saveSettings(svc, { lastQueuedDay: pacificDay() }, by);
  return { queued: true, taskId: (ins as { id: string }).id, clients: batch.length };
}

/* ── The Mini's report ──────────────────────────────────────────────────── */
export type EngageReport = {
  blocked?: boolean;           // Instagram showed "Try again later" / action blocked / a challenge
  clients?: Array<{
    username: string;
    followed?: boolean;        // we follow them now
    follows_us?: boolean | null;
    story_viewed?: boolean;
    story_liked?: boolean;
    liked_url?: string | null;
    posted?: string[];         // approved action ids that were posted
    comment_posted?: { post_url?: string; text?: string } | null; // only when approval is off
    draft?: { post_url?: string; context?: string; text?: string } | null;
    error?: string | null;     // private account, not found, …
  }>;
};

export async function onIgEngageClosed(svc: Svc, p: { id: string; status: string; summary: string; data?: unknown }): Promise<void> {
  const rep = (p.data && typeof p.data === "object" ? p.data : {}) as EngageReport;
  const blocked = !!rep.blocked || /IG_BLOCKED|try again later|action blocked|we restrict certain activity/i.test(p.summary);
  if (blocked) {
    await saveSettings(svc, { enabled: false, pausedReason: `Instagram pushed back on ${new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" })}: ${p.summary.slice(0, 160)}` }, "Mac Mini");
    await textOwner(svc, `📸 Instagram engagement switched OFF: Instagram showed a warning on the Mac Mini (${p.summary.slice(0, 100)}). Nothing more will run until you turn it back on in the Instagram tab — wait a few days first.`).catch(() => null);
  }
  const t = now();
  const actions: Array<Record<string, unknown>> = [];
  for (const c of rep.clients ?? []) {
    const username = usernameFromLink(c.username);
    if (!username) continue;
    const patch: Record<string, unknown> = { updated_at: t };
    const did: string[] = [];
    if (c.followed) { patch.followed_at = t; }
    if (typeof c.follows_us === "boolean") patch.follows_us = c.follows_us;
    if (c.followed) did.push("follow");
    if (c.story_viewed) did.push(c.story_liked ? "story ♥" : "story");
    if (c.liked_url) did.push("like");
    if (c.posted?.length || c.comment_posted) did.push("comment");
    patch.last_error = c.error ? String(c.error).slice(0, 200) : null;
    if (did.length) { patch.last_engaged_at = t; patch.last_action = did.join(" · "); }
    // A follow we already had keeps its original date.
    const { data: prev } = await svc.from("ig_engage_clients").select("followed_at").eq("username", username).maybeSingle();
    if (!prev) continue;
    if ((prev as { followed_at: string | null }).followed_at && c.followed) delete patch.followed_at;
    await svc.from("ig_engage_clients").update(patch).eq("username", username);

    if (c.followed && !(prev as { followed_at: string | null }).followed_at) actions.push({ username, kind: "follow", status: "done", task_id: p.id, done_at: t });
    if (c.story_viewed) actions.push({ username, kind: "story_view", status: "done", task_id: p.id, done_at: t, note: c.story_liked ? "liked a story" : null });
    if (c.liked_url) actions.push({ username, kind: "like", post_url: String(c.liked_url).slice(0, 300), status: "done", task_id: p.id, done_at: t });
    if (c.comment_posted?.text) actions.push({ username, kind: "comment", text: String(c.comment_posted.text).slice(0, 500), post_url: c.comment_posted.post_url ?? null, status: "done", task_id: p.id, done_at: t });
    // A fresh comment idea replaces the client's older one nobody decided on.
    if (c.draft?.text && !blocked) await svc.from("ig_engage_actions").update({ status: "skipped", note: "replaced by a newer idea", decided_at: t }).eq("username", username).eq("status", "draft");
    if (c.draft?.text && !blocked) actions.push({ username, kind: "comment", text: String(c.draft.text).slice(0, 500), post_url: c.draft.post_url ?? null, context: c.draft.context ? String(c.draft.context).slice(0, 300) : null, status: "draft", task_id: p.id });
    for (const id of c.posted ?? []) {
      await svc.from("ig_engage_actions").update({ status: "done", done_at: t, task_id: p.id }).eq("id", id).eq("status", "approved");
    }
  }
  if (actions.length) await svc.from("ig_engage_actions").insert(actions);
}
