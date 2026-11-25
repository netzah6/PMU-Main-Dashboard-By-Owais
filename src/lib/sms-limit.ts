import { createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken } from "@/lib/ghl-app";
import { fileAlert, loadTeamLookup } from "@/lib/alerts";
import { normalizeOwnerKey } from "@/lib/normalizers";

/* ── Daily text limit reached ─────────────────────────────────────────────
   Every GHL sub-account has a daily SMS cap (Settings → Phone System →
   Messaging → Messaging limits; 250 by default, 400 on most client accounts
   since 10/28/2026). Once it is reached EVERY text from the account stops —
   the AI, follow-ups, reminders and staff texts — until GHL's reset time the
   next day. Nobody saw it: Annie Eyelash hit 250 on 11/24/2026 during a
   Black Friday blast and the staff's own replies to a lead failed silently.

   Owner (11/25/2026): when an account reaches the limit, put it on the
   🚨 Alerts tab AND tell the client's Client Success Coach (meta.csm → the
   coach's pop-up, /api/alerts/mine).

   How it is seen: GHL saves each blocked text as an outbound message with
   status "failed" and the error
     "You have reached your SMS sending limit of 250 for the day. You can
      start sending message after 2026-11-25 17:04 America/New_York."
   The synced conversation copy has no message status and syncs only every
   3 h, so each run reads the newest conversations of every texting account
   live. One alert per account per blocked day; it closes by itself when the
   reset time passes or a newer text goes out fine (limit raised). */

type Svc = ReturnType<typeof createServiceClient>;

const G = "https://services.leadconnectorhq.com";
const LIMIT_RE = /SMS sending limit of\s*(\d+)/i;
const AFTER_RE = /after\s+(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::\d{2})?\s*([AP]M)?\s+([A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)*)/i;
const GOOD = new Set(["sent", "delivered", "read"]);
const LOOKBACK_MS = 26 * 3600_000; // a cap resets within a day; older failures are history
const CONVS_PER_ACCOUNT = 3;
const CONCURRENCY = 6;

export const messagingLimitsUrl = (locationId: string) =>
  `https://app.gohighlevel.com/v2/location/${locationId}/settings/phone_system?tab=messaging&childtab=messaging-limits`;

/* Offset (ms) of an IANA zone at a moment: local wall time minus UTC. */
function tzOffsetMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour") % 24, n("minute"), n("second")) - Math.floor(ms / 1000) * 1000;
}

/* "2026-11-25 17:04 America/New_York" → epoch ms. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - tzOffsetMs(guess, tz);
  t = guess - tzOffsetMs(t, tz); // second pass lands right across a DST change
  return t;
}

export type LimitError = { limit: number | null; resumeAt: number | null };

/* Reads GHL's limit error; null when the text is not a daily-limit failure. */
export function parseLimitError(err: unknown): LimitError | null {
  const s = String(err ?? "");
  /* Two wordings seen (Annie Eyelash, 11/24/2026): "…SMS sending limit of 250
     for the day. You can start sending message after <date time zone>." and,
     on the first blocked text, "This location has reached its daily message
     limit. Please try again tomorrow." (no reset time → a day is assumed). */
  if (!(/sending limit/i.test(s) && /for the day/i.test(s)) && !/daily message limit/i.test(s)) return null;
  const lim = s.match(LIMIT_RE);
  const a = s.match(AFTER_RE);
  let resumeAt: number | null = null;
  if (a) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: a[7] }); // throws on a junk zone
      let h = +a[4];
      if (a[6]) h = (h % 12) + (/pm/i.test(a[6]) ? 12 : 0);
      resumeAt = zonedToUtc(+a[1], +a[2], +a[3], h, +a[5], a[7]);
    } catch { resumeAt = null; }
  }
  return { limit: lim ? Number(lim[1]) : null, resumeAt };
}

/* GET with a 20 s timeout; retries 429/5xx from a shared budget. */
async function getJson<T>(url: string, headers: Record<string, string>, budget: { retries: number }): Promise<T> {
  let last = "no answer";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) {
      if (budget.retries <= 0) break;
      budget.retries--;
      await new Promise((r) => setTimeout(r, attempt === 1 ? 2000 : 6000));
    }
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(20_000), cache: "no-store" });
      if (r.ok) return (await r.json()) as T;
      last = `GHL ${r.status}`;
      if (r.status !== 429 && r.status < 500) break;
    } catch (e) { last = String((e as Error).message ?? e).slice(0, 80); }
  }
  throw new Error(last);
}

type Msg = { id: string; direction?: string; status?: string; messageType?: string; dateAdded?: string; error?: unknown };
type Conv = { id: string; lastMessageDate?: number | string };

export type AccountCheck =
  | { state: "blocked"; limit: number | null; resumeAt: number; failedAt: number }
  | { state: "clear"; goodAfter: number | null }
  | { state: "unknown"; why: string };

/* Live look at one account's newest conversations. */
export async function checkAccount(locationId: string, budget: { retries: number }, now = Date.now()): Promise<AccountCheck> {
  let tok = await getAppLocationToken(locationId);
  if (!tok.token) { await new Promise((r) => setTimeout(r, 2000)); tok = await getAppLocationToken(locationId); }
  if (!tok.token) return { state: "unknown", why: `no GHL access (${String(tok.error ?? "token").slice(0, 60)})` };
  const H = { Authorization: `Bearer ${tok.token}`, Version: "2021-04-15", Accept: "application/json" };
  let convs: Conv[];
  try {
    const s = await getJson<{ conversations?: Conv[] }>(`${G}/conversations/search?locationId=${locationId}&limit=10&sort=desc&sortBy=last_message_date`, H, budget);
    convs = (s.conversations ?? [])
      .filter((c) => now - Number(c.lastMessageDate ?? 0) < LOOKBACK_MS)
      .sort((a, b) => Number(b.lastMessageDate ?? 0) - Number(a.lastMessageDate ?? 0))
      .slice(0, CONVS_PER_ACCOUNT);
  } catch (e) { return { state: "unknown", why: String((e as Error).message ?? e).slice(0, 80) }; }
  let fail: { limit: number | null; resumeAt: number; failedAt: number } | null = null;
  let goodAt: number | null = null;
  let realResume: number | null = null, limit: number | null = null;
  for (const c of convs) {
    let ms: Msg[];
    try {
      const m = await getJson<{ messages?: { messages?: Msg[] } }>(`${G}/conversations/${c.id}/messages?limit=8`, H, budget);
      ms = m.messages?.messages ?? [];
    } catch { continue; }
    for (const x of ms) {
      if (x.direction !== "outbound" || x.messageType !== "TYPE_SMS") continue;
      const at = Date.parse(String(x.dateAdded ?? ""));
      if (!Number.isFinite(at) || at > now || now - at > LOOKBACK_MS) continue;
      if (String(x.status ?? "") === "failed") {
        const p = parseLimitError(x.error);
        if (!p) continue;
        if (p.resumeAt != null && (realResume == null || p.resumeAt > realResume)) realResume = p.resumeAt;
        if (p.limit != null) limit = p.limit;
        if (!fail || at > fail.failedAt) fail = { limit: p.limit, resumeAt: at + 24 * 3600_000, failedAt: at };
      } else if (GOOD.has(String(x.status ?? ""))) {
        if (goodAt == null || at > goodAt) goodAt = at;
      }
    }
  }
  // Blocked = a limit failure whose reset is still ahead, and no text has gone
  // out fine since (a raised limit lets texts through before the reset time).
  // The reset time GHL states wins; only without one is a day assumed
  // (the "daily message limit" wording gives none).
  // A stated time at or before the newest failure belongs to an older block.
  if (fail) fail = { limit: fail.limit ?? limit, resumeAt: realResume != null && realResume > fail.failedAt ? realResume : fail.resumeAt, failedAt: fail.failedAt };
  if (fail && fail.resumeAt > now && !(goodAt != null && goodAt > fail.failedAt)) return { state: "blocked", ...fail };
  return { state: "clear", goodAfter: goodAt };
}

const fmtResume = (ms: number) =>
  new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit" }) + " ET";

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;

/* Who takes care of the client. Exact matches first — the loose
   loadTeamLookup matcher needs only 2 shared words ("brows by…",
   "permanent makeup…") and picked a DIFFERENT client's coach for about 1 in
   4 accounts in the 11/25/2026 review. Order: exact owner name → exact
   business name (GHL account name, then the funnel's client name) → loose. */
export async function loadCoachFinder(svc: Svc) {
  const byOwner = new Map<string, string>(), byBiz = new Map<string, string>();
  const { data: cm } = await svc.from("clients_master").select("data");
  // Live rows win over old/offboarded twins of the same client.
  const rows = ((cm ?? []) as Array<{ data: Record<string, unknown> }>).map((r) => r.data ?? {})
    .sort((a, b) => Number(String(b["col_1"] ?? "") === "Live") - Number(String(a["col_1"] ?? "") === "Live"));
  for (const d of rows) {
    const coach = String(d["Assigned"] ?? "").trim();
    if (!coach) continue;
    const o = normalizeOwnerKey(d["Owner Full Name"]), b = normalizeOwnerKey(d["Business Name"]);
    if (o && !byOwner.has(o)) byOwner.set(o, coach);
    if (b && !byBiz.has(b)) byBiz.set(b, coach);
  }
  const loose = await loadTeamLookup(svc);
  return (owner: string, ...bizNames: string[]): string | null => {
    // The live GHL account name first: the owner can come from an old sync
    // row of a recycled sub-account (Ruby's account still lists a former,
    // offboarded client → the wrong coach, 11/25 review).
    for (const n of bizNames) { const b = normalizeOwnerKey(n); if (b && byBiz.has(b)) return byBiz.get(b)!; }
    const o = normalizeOwnerKey(owner);
    if (o && byOwner.has(o)) return byOwner.get(o)!;
    return loose(owner)?.assigned ?? bizNames.map((n) => loose(n)?.assigned).find(Boolean) ?? null;
  };
}

type OpenRow = { id: string; created_at: string; source_key: string; meta: Record<string, unknown> | null };

export async function scanSmsLimit(svc: Svc, opts: { dryRun?: boolean; only?: string[] } = {}): Promise<{
  accounts: number; blocked: string[]; filed: number; updated: number; resolved: number; unknown: number; error?: string;
}> {
  const now = Date.now();
  const closeIds = async (ids: string[]) => {
    if (!ids.length || opts.dryRun) return 0;
    await svc.from("alerts").update({ status: "resolved", resolved_by: "system (texts going out again)", resolved_at: new Date().toISOString() }).in("id", ids);
    return ids.length;
  };
  // FIRST, needing only the clock: close boxes whose reset time has passed, so
  // a failed or slow run below can never leave a solved box on the tab.
  const { data: open0, error: openErr } = await svc.from("alerts").select("id, created_at, source_key, meta").eq("type", "sms_limit").eq("status", "open");
  // Without a reliable view of the open boxes a run could file a second box for the same block.
  if (openErr) return { accounts: 0, blocked: [], filed: 0, updated: 0, resolved: 0, unknown: 0, error: openErr.message };
  const reset = ((open0 ?? []) as OpenRow[]).filter((o) => { const t = Date.parse(String(o.meta?.resume_at ?? "")); return Number.isFinite(t) && t <= now; });
  let resolved = await closeIds(reset.map((o) => o.id));
  const { data: recentRows } = await svc.from("alerts").select("id, meta, muted, resolved_by, resolved_at").eq("type", "sms_limit").neq("status", "open")
    .gte("created_at", new Date(now - 3 * 86400_000).toISOString());
  const recent = (recentRows ?? []) as Array<{ id: string; meta: Record<string, unknown> | null; muted: boolean | null; resolved_by: string | null; resolved_at: string | null }>;
  const stillOpen = ((open0 ?? []) as OpenRow[]).filter((o) => !reset.includes(o));

  /* Which accounts to check. Every texting account, not only the ones whose
     synced copy is fresh (Permanent Make Up By Yeni's copy stopped 06/25 but
     she texts every day; the agency's own account is never synced):
     recent synced conversations ∪ every account the sync knows ∪ the agency. */
  const owners = new Map<string, string>();
  if (opts.only?.length) for (const id of opts.only) owners.set(id, "");
  else {
    const { data, error } = await svc.rpc("ask_ai_query", {
      q: `SELECT location_id, max(owner_key) AS owner_key FROM ghl_conversations
          WHERE last_message_date > now() - interval '3 days' AND location_id IS NOT NULL
          GROUP BY location_id`,
    });
    if (error) return { accounts: 0, blocked: [], filed: 0, updated: 0, resolved, unknown: 0, error: error.message };
    for (const r of (data ?? []) as Array<{ location_id: string; owner_key: string | null }>) owners.set(r.location_id, r.owner_key ?? "");
    const { data: sync } = await svc.from("ghl_sync_status").select("location_id, owner_key, last_attempt_at").order("last_attempt_at", { ascending: false, nullsFirst: false });
    for (const r of (sync ?? []) as Array<{ location_id: string | null; owner_key: string | null }>) {
      if (r.location_id && !owners.get(r.location_id)) owners.set(r.location_id, r.owner_key ?? owners.get(r.location_id) ?? "");
    }
    const agency = process.env.GHL_LOCATION_ID;
    if (agency && !owners.has(agency)) owners.set(agency, "");
  }
  const accounts = [...owners.keys()];

  const budget = { retries: 8 };
  const results = new Map<string, AccountCheck>();
  let i = 0;
  const worker = async () => {
    while (i < accounts.length) {
      const loc = accounts[i++];
      try { results.set(loc, await checkAccount(loc, budget, now)); }
      catch (e) { results.set(loc, { state: "unknown", why: String(e).slice(0, 80) }); }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const blocked = [...results].filter(([, r]) => r.state === "blocked") as Array<[string, Extract<AccountCheck, { state: "blocked" }>]>;
  const unknown = [...results.values()].filter((r) => r.state === "unknown").length;
  let filed = 0, updated = 0;
  const names: string[] = [];
  if (blocked.length) {
    const coachOf = await loadCoachFinder(svc);
    const { data: funnels } = await svc.from("onebox_clients").select("location_id, client_name");
    const funnelName = new Map(((funnels ?? []) as Array<{ location_id: string | null; client_name: string | null }>).map((f) => [f.location_id ?? "", f.client_name ?? ""]));
    for (const [loc, r] of blocked) {
      // Account name from GHL itself (the synced copy only has the owner).
      let name = "";
      try {
        const tok = await getAppLocationToken(loc);
        const j = (await (await fetch(`${G}/locations/${loc}`, { headers: { Authorization: `Bearer ${tok.token}`, Version: "2021-07-28", Accept: "application/json" }, signal: AbortSignal.timeout(20_000) })).json()) as { location?: { name?: string } };
        name = String(j.location?.name ?? "").trim();
      } catch { /* fall back to the owner */ }
      const owner = owners.get(loc) ?? "";
      const isAgency = loc === process.env.GHL_LOCATION_ID;
      const csm = isAgency ? null : coachOf(owner, name, funnelName.get(loc) ?? "");
      const label = name || funnelName.get(loc) || owner || loc;
      names.push(label);
      const meta = {
        location_id: loc, business: label, owner: owner || null, csm,
        limit: r.limit, resume_at: new Date(r.resumeAt).toISOString(), failed_at: new Date(r.failedAt).toISOString(),
        link: messagingLimitsUrl(loc),
      };
      if (opts.dryRun) { names[names.length - 1] = `${label} → coach ${csm ?? "none"}`; continue; }
      const { count } = await svc.from("alerts").select("id", { count: "exact", head: true })
        .eq("type", "sms_limit").like("source_key", `sms-limit:${loc}:%`).gte("created_at", new Date(now - 30 * 86400_000).toISOString());
      const twin = stillOpen.find((o) => String(o.meta?.location_id ?? "") === loc);
      const text = (n: number) => ({
        title: `${label}: daily text limit reached${r.limit ? ` (${r.limit} texts)` : ""}`,
        detail:
          `This account can't send any texts right now — no AI replies, follow-ups, reminders or staff texts — until about ${fmtResume(r.resumeAt)}. ` +
          `To fix it now: in GHL open Settings → Phone System → Messaging → Messaging limits and raise the daily limit (most client accounts are at 400). ` +
          (n > 1 ? `This is the ${ordinal(n)} time in 30 days. ` : "") +
          `Closes by itself when texts go out again.`,
      });
      // One open box per account: later failures refresh its time, limit and coach.
      if (twin) {
        await svc.from("alerts").update({ ...text(count ?? 1), meta: { ...(twin.meta ?? {}), ...meta } }).eq("id", twin.id);
        updated++;
        continue;
      }
      /* The same block must not come back once its box was closed: by hand
         (Resolve / Don't show again) until its reset time; after "texts went
         out again" only when a NEW failure came after that good text. */
      const handled = recent.filter((o) => String(o.meta?.location_id ?? "") === loc && Date.parse(String(o.meta?.resume_at ?? "")) > now);
      if (handled.some((o) => o.muted || !String(o.resolved_by ?? "").startsWith("system")
        || r.failedAt <= Date.parse(String(o.meta?.good_at ?? o.resolved_at ?? "")))) continue;
      const ok = await fileAlert(svc, {
        type: "sms_limit",
        severity: "high",
        ...text((count ?? 0) + 1),
        // Keyed by the failure that opened it: a new block after this one closes is a new box.
        source_key: `sms-limit:${loc}:${new Date(r.failedAt).toISOString().slice(0, 16)}`,
        meta,
      });
      if (ok) filed++;
    }
  }

  // A text went out fine after the box opened (limit raised) → close it, and
  // remember when, so the same block is not filed again (see `handled`).
  for (const o of stillOpen) {
    const r = results.get(String(o.meta?.location_id ?? ""));
    const failedAt = Date.parse(String(o.meta?.failed_at ?? o.created_at));
    if (opts.dryRun || r?.state !== "clear" || r.goodAfter == null || r.goodAfter <= failedAt) continue;
    const at = new Date().toISOString();
    const { error } = await svc.from("alerts").update({ status: "resolved", resolved_by: "system (texts going out again)", resolved_at: at, meta: { ...(o.meta ?? {}), good_at: new Date(r.goodAfter).toISOString() } }).eq("id", o.id);
    if (!error) resolved++;
  }
  return { accounts: accounts.length, blocked: names, filed, updated, resolved, unknown };
}
