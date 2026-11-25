import { createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken } from "@/lib/ghl-app";
import { fileAlert, ghlJson, loadTeamLookup } from "@/lib/alerts";

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
const AFTER_RE = /after\s+(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::\d{2})?\s+([A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)*)/i;
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
  if (!/sending limit/i.test(s) || !/for the day/i.test(s)) return null;
  const lim = s.match(LIMIT_RE);
  const a = s.match(AFTER_RE);
  let resumeAt: number | null = null;
  if (a) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: a[6] }); // throws on a junk zone
      resumeAt = zonedToUtc(+a[1], +a[2], +a[3], +a[4], +a[5], a[6]);
    } catch { resumeAt = null; }
  }
  return { limit: lim ? Number(lim[1]) : null, resumeAt };
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
    const s = await ghlJson<{ conversations?: Conv[] }>(`${G}/conversations/search?locationId=${locationId}&limit=10&sort=desc&sortBy=last_message_date`, H, budget);
    convs = (s.conversations ?? [])
      .filter((c) => now - Number(c.lastMessageDate ?? 0) < LOOKBACK_MS)
      .sort((a, b) => Number(b.lastMessageDate ?? 0) - Number(a.lastMessageDate ?? 0))
      .slice(0, CONVS_PER_ACCOUNT);
  } catch (e) { return { state: "unknown", why: String((e as Error).message ?? e).slice(0, 80) }; }
  let fail: { limit: number | null; resumeAt: number; failedAt: number } | null = null;
  let goodAt: number | null = null;
  for (const c of convs) {
    let ms: Msg[];
    try {
      const m = await ghlJson<{ messages?: { messages?: Msg[] } }>(`${G}/conversations/${c.id}/messages?limit=8`, H, budget);
      ms = m.messages?.messages ?? [];
    } catch { continue; }
    for (const x of ms) {
      if (x.direction !== "outbound" || x.messageType !== "TYPE_SMS") continue;
      const at = Date.parse(String(x.dateAdded ?? ""));
      if (!Number.isFinite(at) || now - at > LOOKBACK_MS) continue;
      if (String(x.status ?? "") === "failed") {
        const p = parseLimitError(x.error);
        if (!p) continue;
        // No reset time in the error: GHL's cap is per day, so assume a day.
        const resumeAt = p.resumeAt ?? at + 24 * 3600_000;
        if (!fail || at > fail.failedAt) fail = { limit: p.limit, resumeAt, failedAt: at };
      } else if (GOOD.has(String(x.status ?? ""))) {
        if (goodAt == null || at > goodAt) goodAt = at;
      }
    }
  }
  // Blocked = a limit failure whose reset is still ahead, and no text has gone
  // out fine since (a raised limit lets texts through before the reset time).
  if (fail && fail.resumeAt > now && !(goodAt != null && goodAt > fail.failedAt)) return { state: "blocked", ...fail };
  return { state: "clear", goodAfter: goodAt };
}

const fmtResume = (ms: number) =>
  new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit" }) + " ET";

export async function scanSmsLimit(svc: Svc, opts: { dryRun?: boolean; only?: string[] } = {}): Promise<{
  accounts: number; blocked: string[]; filed: number; resolved: number; unknown: number; error?: string;
}> {
  const now = Date.now();
  // Accounts that texted or got texts in the last 3 days (synced copy; only used to pick who to check).
  let accounts: Array<{ location_id: string; owner_key: string | null }>;
  if (opts.only?.length) accounts = opts.only.map((id) => ({ location_id: id, owner_key: null }));
  else {
    const { data, error } = await svc.rpc("ask_ai_query", {
      q: `SELECT location_id, max(owner_key) AS owner_key FROM ghl_conversations
          WHERE last_message_date > now() - interval '3 days' AND location_id IS NOT NULL
          GROUP BY location_id`,
    });
    if (error) return { accounts: 0, blocked: [], filed: 0, resolved: 0, unknown: 0, error: error.message };
    accounts = (data ?? []) as typeof accounts;
  }
  const budget = { retries: 8 };
  const results = new Map<string, AccountCheck>();
  let i = 0;
  const worker = async () => {
    while (i < accounts.length) {
      const a = accounts[i++];
      try { results.set(a.location_id, await checkAccount(a.location_id, budget, now)); }
      catch (e) { results.set(a.location_id, { state: "unknown", why: String(e).slice(0, 80) }); }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const blocked = [...results].filter(([, r]) => r.state === "blocked") as Array<[string, Extract<AccountCheck, { state: "blocked" }>]>;
  const unknown = [...results.values()].filter((r) => r.state === "unknown").length;
  let filed = 0;
  const names: string[] = [];
  if (blocked.length) {
    const team = await loadTeamLookup(svc);
    const ownerKey = new Map(accounts.map((a) => [a.location_id, a.owner_key]));
    for (const [loc, r] of blocked) {
      // Account name from GHL itself (the synced copy only has the owner).
      let name = "";
      try {
        const tok = await getAppLocationToken(loc);
        const j = (await (await fetch(`${G}/locations/${loc}`, { headers: { Authorization: `Bearer ${tok.token}`, Version: "2021-07-28", Accept: "application/json" } })).json()) as { location?: { name?: string } };
        name = String(j.location?.name ?? "").trim();
      } catch { /* fall back to the owner */ }
      const owner = ownerKey.get(loc) ?? "";
      const who = team(name) ?? team(owner);
      const label = name || owner || loc;
      names.push(label);
      const day = new Date(r.resumeAt).toISOString().slice(0, 10);
      const { count } = await svc.from("alerts").select("id", { count: "exact", head: true })
        .eq("type", "sms_limit").like("source_key", `sms-limit:${loc}:%`).gte("created_at", new Date(now - 30 * 86400_000).toISOString());
      const before = count ?? 0;
      if (opts.dryRun) continue;
      const ok = await fileAlert(svc, {
        type: "sms_limit",
        severity: "high",
        title: `${label}: daily text limit reached${r.limit ? ` (${r.limit} texts)` : ""}`,
        detail:
          `This account can't send any texts right now — no AI replies, follow-ups, reminders or staff texts — until about ${fmtResume(r.resumeAt)}. ` +
          `To fix it now: in GHL open Settings → Phone System → Messaging → Messaging limits and raise the daily limit (most client accounts are at 400). ` +
          (before ? `This is the ${before + 1}${before + 1 === 2 ? "nd" : before + 1 === 3 ? "rd" : "th"} time in 30 days. ` : "") +
          `Closes by itself when texts go out again.`,
        source_key: `sms-limit:${loc}:${day}`,
        meta: {
          location_id: loc, business: label, owner: owner || null, csm: who?.assigned ?? null,
          limit: r.limit, resume_at: new Date(r.resumeAt).toISOString(), failed_at: new Date(r.failedAt).toISOString(),
          link: messagingLimitsUrl(loc),
        },
      });
      if (ok) filed++;
    }
  }

  // Close boxes whose account can text again: reset time passed, or a text
  // went out fine after the alert was filed (limit raised).
  let resolved = 0;
  if (!opts.dryRun) {
    const { data: open } = await svc.from("alerts").select("id, created_at, meta").eq("type", "sms_limit").eq("status", "open");
    const toClose: string[] = [];
    for (const o of (open ?? []) as Array<{ id: string; created_at: string; meta: Record<string, unknown> | null }>) {
      const m = o.meta ?? {};
      const resume = Date.parse(String(m.resume_at ?? ""));
      const failedAt = Date.parse(String(m.failed_at ?? o.created_at));
      const r = results.get(String(m.location_id ?? ""));
      const textedSince = r?.state === "clear" && r.goodAfter != null && r.goodAfter > failedAt;
      if ((Number.isFinite(resume) && resume <= now) || textedSince) toClose.push(o.id);
    }
    if (toClose.length) {
      await svc.from("alerts").update({ status: "resolved", resolved_by: "system (texts going out again)", resolved_at: new Date().toISOString() }).in("id", toClose);
      resolved = toClose.length;
    }
  }
  return { accounts: accounts.length, blocked: names, filed, resolved, unknown };
}
