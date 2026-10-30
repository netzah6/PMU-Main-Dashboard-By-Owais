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

   Two groups (owner 10/30/2026, "maximize profits"):
   • current clients — every one-box funnel's Instagram link (new sign-ups land
     automatically) — retention, a visit a week;
   • former clients — the win-back list (left on good terms only), ranked by
     lifetime value then how recently they left — a visit a week for 8 weeks,
     then once a month; after 5 months with no follow-back the dashboard stops
     on its own (owner: "should we follow up forever?" — no).
   Accounts that haven't posted in 30 days drop to a monthly visit: engaging
   an empty account is wasted daily budget. Each run is ~60% current, ~40%
   former. Former clients without a known handle are looked up by the Mini
   (business name + city search) and wait on the tab for a yes.
   Status engage / paused / blocked + a note decides who the Mini visits. Task cards: agent_proposals, conversation_id
   'igengage:<iso time>', location 'instagram' (the worker's prompt switches
   on it). The Mini's structured report comes back in finish's `data`. */

type Svc = SupabaseClient;
const now = () => new Date().toISOString();

export const IGE_PREFIX = "igengage:";
export const IGE_LOCATION = "instagram"; // not a GHL sub-account — the worker's prompt switches on it
export const SETTINGS_KEY = "ig_engage";
export const OUR_HANDLE = "pmubookings.ondemand";

export type EngageStatus = "engage" | "paused" | "blocked";
export type Segment = "current" | "former";
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
const DAY = 86_400_000;
const FORMER_WARM_DAYS = 56;       // 8 weeks of weekly visits for a former client…
const FORMER_STOP_DAYS = 150;      // …then monthly; ~5 months with no follow-back = stop
const QUIET_ACCOUNT_DAYS = 30;     // no post in 30 days = visit monthly
const FORMER_SHARE = 0.4;

/* Days until this client is due again. */
export function revisitDays(c: EngageClient): number {
  if (c.status !== "engage") return Infinity;
  if (c.last_post_at && Date.now() - Date.parse(c.last_post_at) > QUIET_ACCOUNT_DAYS * DAY) return 30;
  if (c.segment === "former" && c.engage_started_at && !c.follows_us && Date.now() - Date.parse(c.engage_started_at) > FORMER_WARM_DAYS * DAY) return 30;
  return 7;
}

/* ── Clients ────────────────────────────────────────────────────────────────
   current = one row per one-box Instagram link; owner's full name from the
   live owner → location map, else the funnel's owner name.
   former = win-back rows that left on good terms (verdict ok / no chat, not
   lost), never someone who is a current client again. Handle from Clients
   Master "IG Page link"; none → a lookup row the Mini searches for. */
type OneboxRow = { slug: string; location_id: string | null; client_name: string | null; status: string; config: { igLink?: string; ownerName?: string } | null; extras: { igFeed?: { profile?: { username?: string } } } | null };
const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/[^a-z]+/g, " ").trim();
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function monthToDate(v: unknown): string | null {
  const m = String(v ?? "").trim().toLowerCase().match(/^([a-z]{3})[a-z]*\.?\s+(\d{4})$/);
  const i = m ? MONTHS.indexOf(m[1]) : -1;
  return i >= 0 ? `${m![2]}-${String(i + 1).padStart(2, "0")}-01` : null;
}

export async function syncClients(svc: Svc): Promise<{ added: number; former: number; lookups: number }> {
  const [{ data: boxes }, { data: have }, { data: status }, { data: cm }, { data: wb }, { data: lk }, { data: pay }] = await Promise.all([
    svc.from("onebox_clients").select("slug, location_id, client_name, status, config, extras"),
    svc.from("ig_engage_clients").select("username, slug, owner_name, segment, ltv, left_at"),
    svc.from("ghl_sync_status").select("owner_key, location_id"),
    svc.from("clients_master").select("data"),
    svc.from("winback_contacts").select("owner_name, business, last_paid, review_verdict, active, outcome"),
    svc.from("ig_engage_lookups").select("owner_name, status"),
    // This month's Financing tab: anyone paying / prepaid / PPS / on a free month is a client today.
    svc.from("client_payments").select("owner_key, client_name, payment_status"),
  ]);
  const master = new Map<string, Record<string, unknown>>();
  const byBusiness = new Map<string, Record<string, unknown>>();
  for (const r of (cm ?? []) as Array<{ data: Record<string, unknown> }>) {
    const k = norm(r.data["Owner Full Name"]); if (k && !master.has(k)) master.set(k, r.data);
    const b = norm(r.data["Business Name"]).replace(/ /g, ""); if (b) byBusiness.set(b, r.data); // later rows = newer sign-ups win
  }
  const ownerByLoc = new Map<string, string>();
  for (const r of (status ?? []) as Array<{ owner_key: string; location_id: string }>) if (r.location_id) ownerByLoc.set(r.location_id, r.owner_key);
  const fullName = (key: string | undefined) => (key ? String(master.get(norm(key))?.["Owner Full Name"] ?? "").trim() || key.replace(/\b\w/g, (c) => c.toUpperCase()) : null);

  type Have = { username: string; slug: string | null; owner_name: string | null; segment: Segment; ltv: number | null; left_at: string | null };
  const known = new Map(((have ?? []) as Have[]).map((r) => [r.username, r]));
  const rows: Array<Record<string, unknown>> = [];
  const fixes: Array<{ username: string; patch: Record<string, unknown> }> = [];
  const currentOwners = new Set<string>();
  const currentBusinesses = new Set<string>();
  for (const p of (pay ?? []) as Array<{ owner_key: string | null; client_name: string | null; payment_status: string | null }>) {
    if (!/^(paid|pps|ppa|grace|pending|need more)/i.test(String(p.payment_status ?? "").trim())) continue;
    for (const n of [p.owner_key, p.client_name]) if (n) currentOwners.add(norm(n));
  }
  /* Owner name: Clients Master row of the same business first; the live
     owner → location map only when it agrees with the funnel's own owner
     first name (recycled sub-accounts keep an old owner on the map —
     Naples Beauty showed the previous owner). */
  const ownerOf = (b: OneboxRow): string | null => {
    const first = norm(b.config?.ownerName).split(" ")[0] ?? "";
    const cmRow = byBusiness.get(norm(b.client_name).replace(/ /g, ""));
    const fromCm = String(cmRow?.["Owner Full Name"] ?? "").trim();
    if (fromCm && (!first || norm(fromCm).split(" ").includes(first))) return fromCm;
    const mapped = fullName(b.location_id ? ownerByLoc.get(b.location_id) : undefined);
    if (mapped && (!first || norm(mapped).split(" ")[0] === first)) return mapped;
    return b.config?.ownerName?.trim() || fromCm || mapped || null;
  };

  for (const b of (boxes ?? []) as OneboxRow[]) {
    const u = usernameFromLink(b.config?.igLink) ?? usernameFromLink(b.extras?.igFeed?.profile?.username);
    const owner = ownerOf(b);
    if (owner) currentOwners.add(norm(owner));
    if (b.status === "live" && b.client_name) currentBusinesses.add(norm(b.client_name).replace(/ /g, ""));
    if (!u) continue;
    const k = known.get(u);
    if (k) {
      // A former client who came back becomes current again.
      const patch: Record<string, unknown> = {};
      if (owner && k.owner_name !== owner) patch.owner_name = owner;
      if (k.segment !== "current" && b.status === "live") patch.segment = "current";
      if (Object.keys(patch).length) fixes.push({ username: u, patch });
      continue;
    }
    known.set(u, { username: u, slug: b.slug, owner_name: owner, segment: "current", ltv: null, left_at: null });
    rows.push({ username: u, slug: b.slug, client_name: b.client_name, owner_name: owner, segment: "current", status: b.status === "live" ? "engage" : "paused", updated_by: "sync" });
  }

  type Wb = { owner_name: string; business: string | null; last_paid: string | null; review_verdict: string | null; active: boolean; outcome: string | null };
  const lookups: Array<Record<string, unknown>> = [];
  const lookupKnown = new Set(((lk ?? []) as Array<{ owner_name: string }>).map((r) => norm(r.owner_name)));
  const ownersWithHandle = new Set([...known.values()].map((r) => norm(r.owner_name)));
  let former = 0;
  for (const w of (wb ?? []) as Wb[]) {
    if (!w.active || w.outcome === "lost" || !["ok", "no_chat"].includes(w.review_verdict ?? "")) continue;
    const key = norm(w.owner_name);
    if (!key || currentOwners.has(key) || ownersWithHandle.has(key) || currentBusinesses.has(norm(w.business).replace(/ /g, ""))) continue;
    const m = master.get(key);
    const left = monthToDate(w.last_paid);
    const u = usernameFromLink(m?.["IG Page link"]);
    if (u && !known.has(u)) {
      known.set(u, { username: u, slug: null, owner_name: w.owner_name, segment: "former", ltv: null, left_at: left });
      ownersWithHandle.add(key);
      rows.push({ username: u, client_name: w.business, owner_name: w.owner_name, segment: "former", left_at: left, status: "engage", updated_by: "sync" });
      former++;
    } else if (!u && !lookupKnown.has(key)) {
      const addr = String(m?.["Location (Full adress)"] ?? "");
      lookups.push({ owner_name: w.owner_name, business: w.business, city: addr.trim().slice(0, 100) || null, left_at: left });
      lookupKnown.add(key);
    }
  }
  // A former client who signed up again is a current client now.
  for (const k of known.values()) {
    if (k.segment === "former" && k.owner_name && currentOwners.has(norm(k.owner_name))) fixes.push({ username: k.username, patch: { segment: "current" } });
  }
  const backAgain = ((lk ?? []) as Array<{ owner_name: string; status: string }>).filter((l) => l.status === "todo" && currentOwners.has(norm(l.owner_name))).map((l) => l.owner_name);
  if (backAgain.length) await svc.from("ig_engage_lookups").delete().in("owner_name", backAgain);
  if (rows.length) await svc.from("ig_engage_clients").upsert(rows, { onConflict: "username", ignoreDuplicates: true });
  for (const f of fixes) await svc.from("ig_engage_clients").update(f.patch).eq("username", f.username);
  if (lookups.length) await svc.from("ig_engage_lookups").upsert(lookups, { onConflict: "owner_name", ignoreDuplicates: true });
  return { added: rows.length, former, lookups: lookups.length };
}

export type EngageClient = {
  username: string; slug: string | null; client_name: string | null; owner_name: string | null; status: EngageStatus; note: string | null;
  segment: Segment; ltv: number | null; left_at: string | null; last_post_at: string | null; engage_started_at: string | null;
  followed_at: string | null; follows_us: boolean | null; last_engaged_at: string | null; last_action: string | null; last_error: string | null;
};

/* Who the Mini visits today: never-followed first (newest sign-ups get
   followed within days), then whoever waited longest past their revisit.
   ~60% current clients, ~40% former (ranked by lifetime value, then the most
   recent leavers); a short side lends its unused slots to the other. */
export function pickDue(clients: EngageClient[], n: number, must: Set<string> = new Set()): EngageClient[] {
  const t = Date.now();
  const due = clients.filter((c) => {
    if (c.status !== "engage") return false;
    if (must.has(c.username)) return true;
    if (!c.followed_at || !c.last_engaged_at) return true;
    return t - Date.parse(c.last_engaged_at) >= revisitDays(c) * DAY;
  });
  const waited = (c: EngageClient) => (c.followed_at ? 0 : -1e13) + (c.last_engaged_at ? Date.parse(c.last_engaged_at) : 0);
  const forced = due.filter((c) => must.has(c.username));
  const cur = due.filter((c) => !must.has(c.username) && c.segment !== "former").sort((a, b) => waited(a) - waited(b));
  const old = due.filter((c) => !must.has(c.username) && c.segment === "former").sort((a, b) =>
    (b.ltv ?? -1) - (a.ltv ?? -1) || String(b.left_at ?? "").localeCompare(String(a.left_at ?? "")) || waited(a) - waited(b));
  const room = Math.max(0, n - forced.length);
  let oldN = Math.min(old.length, Math.round(room * FORMER_SHARE));
  const curN = Math.min(cur.length, room - oldN);
  oldN = Math.min(old.length, room - curN);
  return [...forced, ...cur.slice(0, curN), ...old.slice(0, oldN)];
}

/* Former clients 5 months in with no follow-back: stop (owner can turn them
   back on). Returns how many were stopped. */
export async function retireFormer(svc: Svc): Promise<number> {
  const cutoff = new Date(Date.now() - FORMER_STOP_DAYS * DAY).toISOString();
  const { data } = await svc.from("ig_engage_clients").update({
    status: "paused", note: "no follow-back after 5 months — stopped automatically", updated_at: now(), updated_by: "auto",
  }).eq("segment", "former").eq("status", "engage").lt("engage_started_at", cutoff).not("follows_us", "is", true).select("username");
  return (data ?? []).length;
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

const LOOKUPS_PER_RUN = 3; // searching is normal app use, but it still counts as activity

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
  await retireFormer(svc);

  const [{ data: cl }, { data: appr }, { data: lk }] = await Promise.all([
    svc.from("ig_engage_clients").select("*"),
    svc.from("ig_engage_actions").select("id, username, kind, text, post_url").eq("status", "approved").order("decided_at").limit(30),
    svc.from("ig_engage_lookups").select("owner_name, business, city").eq("status", "todo")
      .order("ltv", { ascending: false, nullsFirst: false }).order("left_at", { ascending: false, nullsFirst: false }).limit(LOOKUPS_PER_RUN),
  ]);
  const clients = (cl ?? []) as EngageClient[];
  const active = new Set(clients.filter((c) => c.status === "engage").map((c) => c.username));
  const approved = ((appr ?? []) as Array<{ id: string; username: string; kind: string; text: string; post_url: string | null }>).filter((a) => active.has(a.username));
  const must = new Set(approved.map((a) => a.username));
  const batch = pickDue(clients, dailyQuota(s.startedAt), must);
  const finds = (lk ?? []) as Array<{ owner_name: string; business: string | null; city: string | null }>;
  if (!batch.length && !finds.length) return { queued: false, why: "nobody is due today" };

  const ts = now();
  const lines = batch.map((c, i) => {
    const posts = approved.filter((a) => a.username === c.username);
    const todo = [
      c.followed_at ? "we already follow them (check; follow if not)" : "FOLLOW them (we don't yet)",
      "watch their stories if they have any (let each play a few seconds) and tap the heart on one",
      "like their newest post or reel",
      ...posts.map((a) => `POST this approved comment (action id ${a.id}) on ${a.post_url ?? "their newest post"}: """${a.text}"""`),
      s.approveComments ? "write ONE comment idea for their newest post (do NOT post it) — it goes to the owner for approval" : "write and POST one short comment on their newest post",
      "note how many days ago their newest post was made (report it as last_post_days)",
    ];
    const who = [c.owner_name, c.client_name].filter(Boolean).join(", ");
    return `${i + 1}. @${c.username}${who ? ` (${who}${c.segment === "former" ? " — a former client" : ""})` : ""} — ${todo.join("; ")}`;
  });
  const findLines = finds.map((f, i) => `FIND ${i + 1}: a former client's Instagram — ${f.owner_name}${f.business ? `, business "${f.business}"` : ""}${f.city ? `, ${f.city}` : ""}. Use Instagram's search (the business name first, then the person's name). Open at most 3 likely profiles; pick the one whose name, bio or location clearly matches (a permanent makeup / brows / beauty artist in that area). Do NOT follow, like or message it — only report the handle and why it matches, or that you could not find it.`);
  const plan = [
    "Open https://www.instagram.com/ and confirm you are signed in as @pmubookings.ondemand. Scroll the home feed for about 20 seconds first, like a person opening the app.",
    ...lines,
    ...findLines,
    "Finish by scrolling the home feed for about 15 seconds, then report.",
  ];
  const { data: ins, error } = await svc.from("agent_proposals").insert({
    conversation_id: `${IGE_PREFIX}${ts}`, message_id: `igengage#${ts.slice(0, 16)}`, contact_id: null,
    contact_name: "Instagram engagement", channel: null,
    client_message: `Daily Instagram engagement — ${batch.length} client${batch.length === 1 ? "" : "s"}${finds.length ? ` + ${finds.length} account lookup${finds.length === 1 ? "" : "s"}` : ""} (warm-up week ${warmupWeek(s.startedAt)}). Queued by ${by}.`,
    summary: `Instagram: engage with ${batch.length} client${batch.length === 1 ? "" : "s"}`,
    action_type: "account_change", proposed_reply: null,
    action_detail: JSON.stringify({ usernames: batch.map((c) => c.username), finds: finds.map((f) => f.owner_name), approved: approved.map((a) => a.id), approveComments: s.approveComments }),
    action_plan: plan.map((what) => ({ type: "manual", what })),
    location_id: IGE_LOCATION, status: "queued_browser", decided_by: `${by} (Instagram)`, decided_at: ts, executed_at: ts,
    result: "⏳ Waiting for the AI Agent (Instagram)", browser_attempts: 0,
  }).select("id").maybeSingle();
  if (error || !ins) return { queued: false, why: error?.message ?? "insert failed" };
  if (finds.length) await svc.from("ig_engage_lookups").update({ task_id: (ins as { id: string }).id, updated_at: ts }).in("owner_name", finds.map((f) => f.owner_name));
  await saveSettings(svc, { lastQueuedDay: pacificDay() }, by);
  return { queued: true, taskId: (ins as { id: string }).id, clients: batch.length };
}

/* ── The Mini's report ──────────────────────────────────────────────────── */
export type EngageReport = {
  finds?: Array<{ owner_name: string; handle?: string | null; why?: string | null }>;
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
    last_post_days?: number | null;
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
    if (typeof c.last_post_days === "number" && c.last_post_days >= 0 && c.last_post_days < 5000) patch.last_post_at = new Date(Date.now() - c.last_post_days * DAY).toISOString();
    // A follow we already had keeps its original date.
    const { data: prev } = await svc.from("ig_engage_clients").select("followed_at, engage_started_at").eq("username", username).maybeSingle();
    if (!prev) continue;
    if ((prev as { followed_at: string | null }).followed_at && c.followed) delete patch.followed_at;
    if (did.length && !(prev as { engage_started_at: string | null }).engage_started_at) patch.engage_started_at = t;
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

  // Account lookups: a found handle waits on the tab for a yes.
  for (const f of rep.finds ?? []) {
    if (!f?.owner_name) continue;
    const handle = usernameFromLink(f.handle);
    await svc.from("ig_engage_lookups").update(handle
      ? { status: "found", candidate: handle, candidate_note: f.why ? String(f.why).slice(0, 200) : null, updated_at: t }
      : { status: "not_found", candidate_note: f.why ? String(f.why).slice(0, 200) : "not found", updated_at: t },
    ).eq("owner_name", f.owner_name).eq("status", "todo");
  }
}

/* Owner's yes on a found handle: the former client joins the engagement list. */
export async function confirmLookup(svc: Svc, ownerName: string, accept: boolean, handleOverride: string | null, by: string): Promise<{ username?: string; error?: string }> {
  const { data: row } = await svc.from("ig_engage_lookups").select("*").eq("owner_name", ownerName).maybeSingle();
  if (!row) return { error: "lookup not found" };
  const r = row as { owner_name: string; business: string | null; candidate: string | null; ltv: number | null; left_at: string | null };
  if (!accept) {
    await svc.from("ig_engage_lookups").update({ status: "rejected", updated_at: now() }).eq("owner_name", ownerName);
    return {};
  }
  const username = usernameFromLink(handleOverride) ?? usernameFromLink(r.candidate);
  if (!username) return { error: "Type the Instagram handle" };
  const { error } = await svc.from("ig_engage_clients").upsert({
    username, client_name: r.business, owner_name: r.owner_name, segment: "former", ltv: r.ltv, left_at: r.left_at, status: "engage", updated_by: by,
  }, { onConflict: "username", ignoreDuplicates: true });
  if (error) return { error: error.message };
  await svc.from("ig_engage_lookups").update({ status: "confirmed", candidate: username, updated_at: now() }).eq("owner_name", ownerName);
  return { username };
}
