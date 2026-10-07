import { getAppLocationToken } from "@/lib/ghl-app";
import { getPmuTasksAccount, GHL_BASE } from "@/lib/ghl-tasks";
import { AGENCY_TZ } from "@/lib/ceo-capacity";

// Conversations / messages live on the 2021-04-15 version of the LeadConnector API.
const CONV_VERSION = "2021-04-15";
const USERS_VERSION = "2021-07-28";

export type PmuAccount = { locationId: string; token: string };

// Re-export the resolver so callers have a single import for the reply feature.
export async function getReplyAccount(): Promise<PmuAccount | null> {
  return getPmuTasksAccount();
}

function authHeaders(token: string, version: string) {
  return {
    Authorization: `Bearer ${token}`,
    Version: version,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

// Friendly channel label from a GHL message-type string (e.g. "TYPE_SMS").
export function channelFromType(t?: string | null): string {
  const s = String(t ?? "").toUpperCase();
  if (s.includes("EMAIL")) return "Email";
  if (s.includes("SMS")) return "SMS";
  if (s.includes("CALL") || s.includes("VOICEMAIL")) return "Call";
  if (s.includes("WHATSAPP")) return "WhatsApp";
  if (s.includes("FACEBOOK") || s === "TYPE_FB") return "FB";
  if (s.includes("INSTAGRAM") || s === "TYPE_IG") return "IG";
  if (s.includes("GMB")) return "GMB";
  if (s.includes("CHAT")) return "Chat";
  return "Msg";
}

export type ConvSummary = {
  id: string;
  contactId: string | null;
  contactName: string;
  lastMessageBody: string;
  lastMessageDirection: string | null;
  lastMessageDate: string | null;
  unreadCount: number;
  channel: string;
  assignedTo: string | null;   // GHL user id the conversation is assigned to
  assignedToName: string;      // resolved to a name by the route (via the roster)
};

// Recent conversations for the PMU Bookings On Demand account.
// Pass { unreadOnly: true } to mirror GHL's "Unread" tab.
export async function getRecentConversations(
  acct: PmuAccount,
  limit = 40,
  opts: { unreadOnly?: boolean } = {}
): Promise<ConvSummary[]> {
  const statusParam = opts.unreadOnly ? "&status=unread" : "";
  const url = `${GHL_BASE}/conversations/search?locationId=${acct.locationId}&limit=${limit}&sortBy=last_message_date&sort=desc${statusParam}`;
  const r = await fetch(url, { headers: authHeaders(acct.token, CONV_VERSION) });
  if (!r.ok) return [];
  const j = (await r.json()) as { conversations?: Array<Record<string, unknown>> };
  let list: ConvSummary[] = (j.conversations ?? []).map((c) => ({
    id: String(c.id),
    contactId: (c.contactId as string) ?? null,
    contactName:
      String(c.fullName ?? c.contactName ?? "").trim() ||
      String(c.email ?? c.phone ?? "Unknown").trim(),
    lastMessageBody: String(c.lastMessageBody ?? "").trim(),
    lastMessageDirection: (c.lastMessageDirection as string) ?? null,
    lastMessageDate:
      c.lastMessageDate != null ? new Date(Number(c.lastMessageDate)).toISOString() : null,
    unreadCount: typeof c.unreadCount === "number" ? (c.unreadCount as number) : 0,
    channel: channelFromType(c.lastMessageType as string | undefined),
    assignedTo: (c.assignedTo as string) ?? null,
    assignedToName: "",
  }));
  // Guard: only keep conversations that actually have unread messages.
  if (opts.unreadOnly) list = list.filter((c) => c.unreadCount > 0);
  return list;
}

export type ThreadMessage = {
  id: string;
  direction: "inbound" | "outbound";
  body: string;
  dateAdded: string | null;
  userId: string | null;
  channel: string;
  source?: string | null; // GHL's "source" (e.g. workflow, campaign, app, api) when given
  attachments?: string[]; // media URLs (photos, voice notes) when the message carries any
};

// Full message history for one conversation, oldest → newest (SMS + email).
/* withAttachments keeps messages that are only media (a photo, a voice note)
   — the chat view shows them; everything that reads the thread as text for
   the AI or alerts keeps the old text-only list. */
/* labelMedia: for readers that only look at text (the AI agent, drafts),
   a media-only message reads as "[voice note]" / "[photo]" instead of
   vanishing — a client answered with a voice note must not look unanswered. */
export async function getThread(acct: PmuAccount, conversationId: string, opts: { signal?: AbortSignal; withAttachments?: boolean; labelMedia?: boolean } = {}): Promise<ThreadMessage[]> {
  const url = `${GHL_BASE}/conversations/${conversationId}/messages?limit=100`;
  const r = await fetch(url, { headers: authHeaders(acct.token, CONV_VERSION), signal: opts.signal });
  if (!r.ok) return [];
  const j = (await r.json()) as { messages?: { messages?: Array<Record<string, unknown>> } };
  const raw = j.messages?.messages ?? [];
  const msgs: ThreadMessage[] = raw
    // GHL interleaves activity notes ("Opportunity updated") and internal
    // team comments with messages — neither was sent to the client.
    .filter((m) => !/ACTIVITY|INTERNAL_COMMENT/i.test(String(m.messageType ?? m.type ?? "")))
    .map((m) => ({
      id: String(m.id),
      direction: (String(m.direction ?? "").toLowerCase() === "inbound"
        ? "inbound"
        : "outbound") as "inbound" | "outbound",
      body: String(m.body ?? "").trim(),
      dateAdded: m.dateAdded ? new Date(String(m.dateAdded)).toISOString() : null,
      userId: (m.userId as string) ?? null,
      channel: channelFromType((m.messageType ?? m.type) as string | undefined),
      source: m.source ? String(m.source) : null,
      attachments: Array.isArray(m.attachments) ? (m.attachments as unknown[]).map(String).filter((u) => /^https?:\/\//.test(u)) : [],
    }))
    .map((m) => (opts.labelMedia && !m.body && m.attachments?.length ? { ...m, body: mediaLabel(m.attachments) } : m))
    .filter((m) => m.body.length > 0 || (!!opts.withAttachments && (m.attachments?.length ?? 0) > 0));
  // GHL returns newest-first; we want chronological for reading + prompting.
  return msgs.reverse();
}

function mediaLabel(urls: string[]): string {
  if (urls.some((u) => /\.(mp3|m4a|aac|amr|wav|ogg|oga|opus|3gp)(\?|$)/i.test(u))) return "[voice note]";
  if (urls.some((u) => /\.(jpe?g|png|gif|webp|heic)(\?|$)/i.test(u))) return "[photo]";
  return "[attachment]";
}

// Friendly channel label → the GHL send-API message type. Email is excluded
// on purpose (it needs subject/html and shouldn't be fired from a quick box).
const SEND_TYPE: Record<string, string> = {
  SMS: "SMS", FB: "FB", IG: "IG", WhatsApp: "WhatsApp", Chat: "Live_Chat", GMB: "GMB",
};

// Send one outbound message into an existing conversation's channel. Manual
// use only — every call is a human clicking Send (or approving the agent's
// proposal); nothing loops over this.
export async function sendConversationMessage(
  acct: PmuAccount,
  // fromNumber: send from this number of the account (e.g. a teammate's own
  // line) instead of the account's default one.
  // scheduledAt (unix seconds): GHL holds the text and sends it then.
  // attachments: public media URLs sent with the text (a voice note's MP3).
  opts: { contactId: string; message: string; channel?: string; fromNumber?: string | null; scheduledAt?: number; attachments?: string[] },
): Promise<{ ok: boolean; error?: string; via?: "app-token"; messageId?: string }> {
  const type = SEND_TYPE[opts.channel ?? "SMS"] ?? "SMS";
  const post = async (token: string) => {
    const r = await fetch(`${GHL_BASE}/conversations/messages`, {
      method: "POST",
      headers: { ...authHeaders(token, CONV_VERSION), "Content-Type": "application/json" },
      body: JSON.stringify({
        type, contactId: opts.contactId,
        // A media-only text (voice note) carries no message field at all.
        ...(opts.message || !opts.attachments?.length ? { message: opts.message } : {}),
        ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
        ...(opts.fromNumber ? { fromNumber: opts.fromNumber } : {}),
        ...(opts.scheduledAt ? { scheduledTimestamp: Math.floor(opts.scheduledAt) } : {}),
      }),
    });
    if (r.ok) {
      const j = (await r.json().catch(() => ({}))) as { messageId?: string };
      return { ok: true as const, messageId: j.messageId ? String(j.messageId) : undefined };
    }
    const text = await r.text().catch(() => "");
    return { ok: false as const, status: r.status, error: `HTTP ${r.status}: ${text.slice(0, 200)}` };
  };
  const first = await post(acct.token);
  if (first.ok) return { ok: true, messageId: first.messageId };
  /* The keys-sheet private token can lack the conversations-write scope
     ("The token is not authorized for this scope") — GHL rejects the text,
     nothing is sent. Every sender gets the marketplace app's location token
     as the fallback (it carries conversations/message.write); this used to
     live only in the manual Send route, so the Performance "Ask to approve"
     button and Agent approvals failed (Cindy Simmons, 2026-10-02). */
  if (first.status === 401 || /not authorized for this scope/i.test(first.error)) {
    const tok = await getAppLocationToken(acct.locationId);
    if (tok.token && tok.token !== acct.token) {
      const retry = await post(tok.token);
      if (retry.ok) return { ok: true, via: "app-token", messageId: retry.messageId };
      return { ok: false, error: `private token: ${first.error} · app token: ${retry.error}` };
    }
  }
  return { ok: false, error: first.error };
}

/* Cancel a text GHL is holding for later (scheduled from the AI tab). Same
   private-token → app-token fallback as sending. */
export async function cancelScheduledMessage(acct: PmuAccount, messageId: string): Promise<{ ok: boolean; error?: string }> {
  const del = async (token: string) => {
    const r = await fetch(`${GHL_BASE}/conversations/messages/${encodeURIComponent(messageId)}/schedule`, {
      method: "DELETE", headers: authHeaders(token, CONV_VERSION),
    });
    if (r.ok) {
      // GHL can answer HTTP 200 with a failure in the body ({ status: 404,
      // message: "Failed cancel the scheduled message" }) — e.g. it already went.
      const j = (await r.json().catch(() => ({}))) as { status?: number; success?: boolean; message?: string };
      if ((typeof j.status === "number" && j.status >= 400) || j.success === false) {
        return { ok: false as const, status: j.status ?? 200, error: `GHL: ${j.message ?? "couldn't cancel"} (${j.status ?? "?"})` };
      }
      return { ok: true as const };
    }
    const text = await r.text().catch(() => "");
    return { ok: false as const, status: r.status, error: `HTTP ${r.status}: ${text.slice(0, 200)}` };
  };
  const first = await del(acct.token);
  if (first.ok) return { ok: true };
  if (first.status === 401 || /not authorized for this scope/i.test(first.error)) {
    const tok = await getAppLocationToken(acct.locationId);
    if (tok.token && tok.token !== acct.token) {
      const retry = await del(tok.token);
      return retry.ok ? { ok: true } : { ok: false, error: `private token: ${first.error} · app token: ${retry.error}` };
    }
  }
  return { ok: false, error: first.error };
}

export type RosterUser = { id: string; name: string; email: string };

// The team roster for the account (id + name + email), used to match the
// logged-in dashboard user to their GHL identity.
export async function getRoster(acct: PmuAccount): Promise<RosterUser[]> {
  const r = await fetch(`${GHL_BASE}/users/?locationId=${acct.locationId}`, {
    headers: authHeaders(acct.token, USERS_VERSION),
  });
  if (!r.ok) return [];
  const j = (await r.json()) as { users?: Array<Record<string, unknown>> };
  return (j.users ?? []).map((u) => ({
    id: String(u.id),
    name:
      String(u.name ?? `${u.firstName ?? ""} ${u.lastName ?? ""}`).trim() ||
      String(u.email ?? ""),
    email: String(u.email ?? "").trim().toLowerCase(),
  }));
}

// ── Per-person voice samples ────────────────────────────────────────────────
// There is no GHL endpoint to list one user's messages, so we scan the most
// recent conversations and collect that user's outbound texts — NEWEST first
// (the old scan read each thread oldest-first and kept his oldest replies) and
// short ones included ("ok", "Done!" are part of how he writes; dropping
// everything under 8 chars made the samples longer and chattier than he is).
// Cached in-process (warm instance) for 6h to avoid re-scanning on every draft.
type VoiceCacheEntry = { ts: number; samples: string[] };
const voiceCache = new Map<string, VoiceCacheEntry>();
const VOICE_TTL_MS = 6 * 60 * 60 * 1000;

/* Texts that carry a password, code or card/bank number must never reach a
   prompt (voice samples, learned examples, client notes) — the model could
   repeat them to another client. */
const SECRET_RE = /pass\s*(word|code)|\bpwd\b|contraseña|\bpin\b|\bcvv\b|\bcvc\b|security\s+code|login\s+code|verification\s+code|\b2fa\b|\botp\b|card\s+(number|no\.?|#)|\bssn\b|social\s+security|routing\s+number|account\s+number|api\s+key|\btoken\b/i;
export const hasSecret = (text: string) => SECRET_RE.test(text);

function looksAutomated(body: string): boolean {
  const b = body.toLowerCase();
  return (
    body.trim().length < 2 ||
    b.includes("http://") ||
    b.includes("https://") ||
    b.includes("www.") ||
    b.includes(".com/") ||
    b.includes("unsubscribe") ||
    b.startsWith("reply stop") ||
    hasSecret(body)
  );
}

export async function getVoiceSamples(
  acct: PmuAccount,
  ghlUserId: string,
  opts: { want?: number; scanConversations?: number } = {}
): Promise<string[]> {
  const want = opts.want ?? 20;
  const scan = opts.scanConversations ?? 40;

  const cached = voiceCache.get(ghlUserId);
  const now = Date.now();
  if (cached && now - cached.ts < VOICE_TTL_MS) return cached.samples;

  const convos = await getRecentConversations(acct, scan);
  // Read threads 8 at a time with an 8 s cap each: a cold instance scanning
  // 40 chats one by one could outrun the 60 s draft/propose routes.
  const threads: ThreadMessage[][] = [];
  for (let i = 0; i < convos.length; i += 8) {
    const batch = await Promise.all(convos.slice(i, i + 8).map((c) =>
      getThread(acct, c.id, { signal: AbortSignal.timeout(8000) }).catch(() => [] as ThreadMessage[])));
    threads.push(...batch);
  }
  const samples: string[] = [];
  const seen = new Set<string>();
  for (const thread of threads) {
    if (samples.length >= want) break;
    // At most 3 per conversation, newest first, so one long thread can't
    // set the whole voice.
    let fromThis = 0;
    for (let i = thread.length - 1; i >= 0 && fromThis < 3; i--) {
      const m = thread[i];
      if (m.direction !== "outbound" || m.userId !== ghlUserId || isAutomatedMessage(m)
        || m.channel === "Email" || m.channel === "Msg" || looksAutomated(m.body)) continue;
      const key = m.body.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      samples.push(m.body.trim());
      fromThis++;
      if (samples.length >= want) break;
    }
  }
  voiceCache.set(ghlUserId, { ts: now, samples });
  return samples;
}

/* Whose voice a draft is written in: the logged-in teammate when their
   dashboard email matches a GHL user, otherwise the owner (Nicolas — the
   default voice for the agency, and the only one the cron's Agent cards can
   use). AGENT_VOICE_NAME overrides the owner's first name if it ever changes. */
export function resolveVoiceUser(roster: RosterUser[], email?: string | null): { user: RosterUser | null; isSelf: boolean } {
  const e = String(email ?? "").trim().toLowerCase();
  const self = e ? roster.find((u) => u.email && u.email === e) ?? null : null;
  if (self) return { user: self, isSelf: true };
  const owner = (process.env.AGENT_VOICE_NAME || "Nicolas").toLowerCase();
  const fallback = roster.find((u) => u.name.toLowerCase().split(/\s+/)[0] === owner) ?? null;
  return { user: fallback, isSelf: false };
}

// A workflow / campaign / bulk text — no person typed it. GHL marks these
// in `source` AND stamps them with the assigned user's id, so a workflow
// reminder looks like Nicolas wrote it unless `source` is checked (live
// check 2026-10-01: 141 typed replies were source "app"; the call-booking
// reminders with ✅ 👍 and the call link were source "workflow" with his id).
export function isAutomatedMessage(m: ThreadMessage): boolean {
  return m.direction === "outbound" && /workflow|campaign|bulk|drip|automation|trigger/i.test(m.source ?? "");
}

/* Index of the first client message nobody has answered yet: walk back from
   the end over the client's texts and over automated texts (a reminder that
   fires after her questions doesn't answer them); stop at the first real
   reply from us. thread.length when nothing is waiting. */
export function firstUnansweredIndex(thread: ThreadMessage[]): number {
  let first = thread.length;
  for (let i = thread.length - 1; i >= 0; i--) {
    const m = thread[i];
    if (m.direction === "inbound") first = i;
    else if (!isAutomatedMessage(m)) break;
  }
  return first;
}

/* The conversation as the AI reads it. Clients often send several texts in
   a row and the meaning sits in yesterday's messages, so:
   - every line carries its day and time, and TODAY is stated up top;
   - the last 2 days are shown in full, plus at least the last 12 messages,
     with up to 20 older ones above a "background only" divider;
   - our outbound lines say WHO sent them: a teammate's name, or
     "Automated" for workflow texts (no user on the message) — so the AI never
     copies a nurture text or its call invite as if it were Nicolas talking;
   - the client's unanswered messages at the end are marked NEW. */
export function formatThreadForPrompt(
  thread: ThreadMessage[],
  opts: { contactName: string; nameByUserId?: Map<string, string>; now?: Date; timeZone?: string },
): string {
  const now = opts.now ?? new Date();
  // The agency's own clock (same constant as the rest of the dashboard).
  const tz = opts.timeZone || process.env.AGENCY_TZ || AGENCY_TZ;
  const who = opts.contactName || "Client";
  const dayKey = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: tz });
  const today = dayKey(now);
  // Calendar-day arithmetic (not "minus 24 h", which slips across DST).
  const [ty, tm, td] = today.split("-").map(Number);
  const yesterday = new Date(Date.UTC(ty, tm - 1, td - 1)).toISOString().slice(0, 10);
  const stamp = (iso: string | null) => {
    if (!iso) return "(time unknown)";
    const d = new Date(iso);
    const k = dayKey(d);
    const time = d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
    const day = k === today ? "Today" : k === yesterday ? "Yesterday"
      : d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" });
    return `${day} ${time}`;
  };
  const sender = (m: ThreadMessage) => {
    if (m.direction === "inbound") return who;
    if (isAutomatedMessage(m)) return "Automated (workflow text — not a person)";
    if (m.userId) return opts.nameByUserId?.get(m.userId) || "Teammate";
    return "Agency (sent without a teammate name, e.g. from the dashboard)";
  };
  const firstNew = firstUnansweredIndex(thread);

  const recentFrom = now.getTime() - 48 * 3_600_000;
  let start = thread.findIndex((m) => m.dateAdded && Date.parse(m.dateAdded) >= recentFrom);
  if (start < 0) start = thread.length;
  start = Math.min(start, Math.max(0, thread.length - 12));
  const older = thread.slice(Math.max(0, start - 20), start);
  const recent = thread.slice(start);

  const line = (m: ThreadMessage, i: number) =>
    `[${stamp(m.dateAdded)}] ${sender(m)}: ${m.body}${i >= firstNew && m.direction === "inbound" ? "   <- NEW, not answered yet" : ""}`;
  const parts = [`Today is ${now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", year: "numeric" })} (${tz}).`];
  if (older.length) {
    parts.push("", "--- Earlier history (background only) ---");
    older.forEach((m) => parts.push(line(m, -1)));
  }
  parts.push("", "--- Recent conversation (last 2 days, oldest first) ---");
  recent.forEach((m) => parts.push(line(m, thread.indexOf(m))));
  if (!thread.length) parts.push("(No prior messages.)");
  return parts.join("\n");
}
