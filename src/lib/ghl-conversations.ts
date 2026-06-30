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

export type ConvSummary = {
  id: string;
  contactId: string | null;
  contactName: string;
  lastMessageBody: string;
  lastMessageDirection: string | null;
  lastMessageDate: string | null;
  unreadCount: number;
};

// Most recent conversations for the PMU Bookings On Demand account.
export async function getRecentConversations(
  acct: PmuAccount,
  limit = 40
): Promise<ConvSummary[]> {
  const url = `${GHL_BASE}/conversations/search?locationId=${acct.locationId}&limit=${limit}&sortBy=last_message_date&sort=desc`;
  const r = await fetch(url, { headers: authHeaders(acct.token, CONV_VERSION) });
  if (!r.ok) return [];
  const j = (await r.json()) as { conversations?: Array<Record<string, unknown>> };
  return (j.conversations ?? []).map((c) => ({
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
  }));
}

export type ThreadMessage = {
  id: string;
  direction: "inbound" | "outbound";
  body: string;
  dateAdded: string | null;
  userId: string | null;
};

// Full message history for one conversation, oldest → newest, SMS/text only.
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
