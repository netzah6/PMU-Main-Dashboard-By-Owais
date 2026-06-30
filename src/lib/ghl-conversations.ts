import { getPmuTasksAccount, GHL_BASE } from "@/lib/ghl-tasks";

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
};

// Full message history for one conversation, oldest → newest (SMS + email).
export async function getThread(acct: PmuAccount, conversationId: string): Promise<ThreadMessage[]> {
  const url = `${GHL_BASE}/conversations/${conversationId}/messages?limit=100`;
  const r = await fetch(url, { headers: authHeaders(acct.token, CONV_VERSION) });
  if (!r.ok) return [];
  const j = (await r.json()) as { messages?: { messages?: Array<Record<string, unknown>> } };
  const raw = j.messages?.messages ?? [];
  const msgs: ThreadMessage[] = raw
    .map((m) => ({
      id: String(m.id),
      direction: (String(m.direction ?? "").toLowerCase() === "inbound"
        ? "inbound"
        : "outbound") as "inbound" | "outbound",
      body: String(m.body ?? "").trim(),
      dateAdded: m.dateAdded ? new Date(String(m.dateAdded)).toISOString() : null,
      userId: (m.userId as string) ?? null,
      channel: channelFromType((m.messageType ?? m.type) as string | undefined),
    }))
    .filter((m) => m.body.length > 0);
  // GHL returns newest-first; we want chronological for reading + prompting.
  return msgs.reverse();
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
// recent conversations and collect that user's outbound texts. Cached in-process
// (warm-instance) for 6h to avoid re-scanning on every draft.
type VoiceCacheEntry = { ts: number; samples: string[] };
const voiceCache = new Map<string, VoiceCacheEntry>();
const VOICE_TTL_MS = 6 * 60 * 60 * 1000;

function looksAutomated(body: string): boolean {
  const b = body.toLowerCase();
  return (
    body.length < 8 ||
    b.includes("http://") ||
    b.includes("https://") ||
    b.includes("unsubscribe") ||
    b.startsWith("reply stop")
  );
}

export async function getVoiceSamples(
  acct: PmuAccount,
  ghlUserId: string,
  opts: { want?: number; scanConversations?: number } = {}
): Promise<string[]> {
  const want = opts.want ?? 12;
  const scan = opts.scanConversations ?? 25;

  const cached = voiceCache.get(ghlUserId);
  // Note: Date.now via fresh Date() — available in route runtime (not the workflow sandbox).
  const now = Date.now();
  if (cached && now - cached.ts < VOICE_TTL_MS) return cached.samples;

  const convos = await getRecentConversations(acct, scan);
  const samples: string[] = [];
  for (const c of convos) {
    if (samples.length >= want) break;
    const thread = await getThread(acct, c.id);
    for (const m of thread) {
      if (m.direction === "outbound" && m.userId === ghlUserId && !looksAutomated(m.body)) {
        samples.push(m.body);
        if (samples.length >= want) break;
      }
    }
  }
  voiceCache.set(ghlUserId, { ts: now, samples });
  return samples;
}
