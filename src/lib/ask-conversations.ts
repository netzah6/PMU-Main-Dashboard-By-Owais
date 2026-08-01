import { createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken } from "@/lib/ghl-app";

// Reading actual chat history for the Ask AI tab.
//
// The rest of Ask AI works off synced aggregates, which can answer "how many"
// but never "what did she actually say". These helpers close that gap: they
// read real message bodies, either from the agency's own account (client ↔
// team) or from any client's sub-account (their leads ↔ them).
//
// Conversations are enumerated from Postgres (ghl_conversations is already
// synced) and only the message bodies are fetched live, which keeps a scan to
// one GHL call per conversation.

const GHL = "https://services.leadconnectorhq.com";
const V = "2021-07-28";
export const AGENCY_LOCATION = "SfpNMJ5YU9lBkxss47lK"; // PMU Bookings On Demand

export type ChatAccount = { locationId: string; token: string; label: string; ownerKey: string | null };

async function gget(url: string, token: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Version: V, Accept: "application/json" } });
    if (!r.ok) return null;
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function pool<I, O>(items: I[], limit: number, worker: (i: I) => Promise<O>): Promise<O[]> {
  const out = new Array<O>(items.length);
  let next = 0;
  async function lane() { while (next < items.length) { const i = next++; out[i] = await worker(items[i]); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => lane()));
  return out;
}

// Which account's chats to read. No client name = the agency's own account,
// where the team talks to the artists themselves.
export async function resolveAccount(clientName?: string): Promise<ChatAccount | { error: string }> {
  if (!clientName || !clientName.trim()) {
    const tok = await getAppLocationToken(AGENCY_LOCATION);
    if (!tok.token) return { error: `no token for the agency account (${tok.error})` };
    return { locationId: AGENCY_LOCATION, token: tok.token, label: "PMU Bookings On Demand (agency account)", ownerKey: null };
  }
  const svc = createServiceClient();
  const q = clientName.trim();
  const { data: masters } = await svc
    .from("clients_master").select("data")
    .or(`data->>Owner Full Name.ilike.%${q}%,data->>Business Name.ilike.%${q}%`)
    .limit(5);
  const rows = (masters ?? []).map((r) => r.data as Record<string, string>);
  const master = rows.find((d) => (d["col_1"] ?? "") === "Live") ?? rows[0];
  if (!master) return { error: `no client in the master sheet matches "${q}"` };
  const owner = String(master["Owner Full Name"] ?? "").trim();
  const ownerKey = owner.toLowerCase();
  const { data: locRow } = await svc.from("ghl_contacts").select("location_id").eq("owner_key", ownerKey).limit(1);
  const locationId = locRow?.[0]?.location_id as string | undefined;
  if (!locationId) return { error: `"${owner}" has no ingested sub-account yet, so their chats can't be read` };
  const tok = await getAppLocationToken(locationId);
  if (!tok.token) return { error: `no token for ${owner}'s sub-account (${tok.error})` };
  return { locationId, token: tok.token, label: `${master["Business Name"] ?? owner} (${owner})`, ownerKey };
}

export type Msg = { at: string; direction: string; body: string };

async function messagesFor(conversationId: string, token: string, cap = 100): Promise<Msg[]> {
  const j = await gget(`${GHL}/conversations/${conversationId}/messages?limit=${cap}`, token);
  const raw = ((j?.messages as Record<string, unknown>)?.messages ?? j?.messages ?? []) as Array<Record<string, unknown>>;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => m.body)
    .map((m) => ({
      at: String(m.dateAdded ?? ""),
      direction: String(m.direction ?? ""),
      body: String(m.body).replace(/\s+/g, " ").trim(),
    }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

// Full back-and-forth with one person.
export async function readThread(
  acct: ChatAccount,
  contactQuery: string,
): Promise<Record<string, unknown>> {
  const svc = createServiceClient();
  const q = contactQuery.trim();
  // Prefer the synced contact table (fast, and matches on email/phone too).
  const base = svc.from("ghl_contacts").select("id, contact_name, email, phone");
  const { data: cands } = await (acct.ownerKey ? base.eq("owner_key", acct.ownerKey) : base.eq("location_id", acct.locationId))
    .or(`contact_name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`)
    .limit(10);
  let contactId = (cands ?? [])[0]?.id as string | undefined;
  let contactName = (cands ?? [])[0]?.contact_name as string | undefined;

  if (!contactId) {
    const live = await gget(`${GHL}/contacts/?locationId=${acct.locationId}&query=${encodeURIComponent(q)}&limit=10`, acct.token);
    const list = (live?.contacts as Array<Record<string, unknown>> | undefined) ?? [];
    if (!list.length) return { error: `no contact matching "${q}" in ${acct.label}` };
    contactId = String(list[0].id);
    contactName = String(list[0].contactName ?? `${list[0].firstName ?? ""} ${list[0].lastName ?? ""}`).trim();
  }

  const search = await gget(`${GHL}/conversations/search?locationId=${acct.locationId}&contactId=${contactId}&limit=20`, acct.token);
  const convos = (search?.conversations as Array<Record<string, unknown>> | undefined) ?? [];
  if (!convos.length) return { account: acct.label, contact: contactName, messages: [], note: "contact exists but has no conversation" };

  const perConvo = await pool(convos, 4, (c) => messagesFor(String(c.id), acct.token));
  const messages = perConvo.flat().sort((a, b) => a.at.localeCompare(b.at));
  return {
    account: acct.label,
    contact: contactName,
    contactId,
    messageCount: messages.length,
    // 'inbound' = the other person wrote; 'outbound' = our side wrote.
    messages: messages.slice(-200),
    truncated: messages.length > 200,
  };
}

export type ScanHit = {
  contact: string;
  contactId: string;
  stage: string | null;
  matches: Array<{ at: string; who: string; text: string }>;
};

// Read every conversation in an account and return the ones whose messages
// match. This is how "find everyone who confirmed a deposit" gets answered —
// there is no such field anywhere, it only exists in what people wrote.
export async function scanMessages(
  acct: ChatAccount,
  opts: { contains: string[]; maxContacts?: number; direction?: "inbound" | "outbound" | "any"; budgetMs?: number },
): Promise<Record<string, unknown>> {
  const svc = createServiceClient();
  const patterns = opts.contains.filter(Boolean).map((p) => {
    try { return new RegExp(p, "i"); } catch { return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
  });
  if (!patterns.length) return { error: "no search terms given" };

  const cap = Math.min(Math.max(opts.maxContacts ?? 200, 1), 400);
  const deadline = Date.now() + (opts.budgetMs ?? 90_000);

  // The ghl_* tables are indexed on owner_key, and only client sub-accounts are
  // ingested — the agency's own account has no synced conversations at all, so
  // its list has to come from the live API.
  let convos: Array<{ id: string; contact_id: string }>;
  if (acct.ownerKey) {
    const { data: convRows, error } = await svc
      .from("ghl_conversations").select("id, contact_id")
      .eq("owner_key", acct.ownerKey)
      .order("last_message_date", { ascending: false })
      .limit(cap);
    if (error) return { error: `couldn't list conversations: ${error.message}` };
    convos = (convRows ?? []) as Array<{ id: string; contact_id: string }>;
  } else {
    const live = await gget(`${GHL}/conversations/search?locationId=${acct.locationId}&limit=100&sort=desc`, acct.token);
    convos = ((live?.conversations as Array<Record<string, unknown>> | undefined) ?? [])
      .map((c) => ({ id: String(c.id), contact_id: String(c.contactId ?? "") }));
  }
  if (!convos.length) return { error: `no conversations found for ${acct.label}` };

  // Stage + name lookups so hits can be judged against where they sit today.
  const [{ data: oppRows }, { data: contactRows }] = await Promise.all([
    acct.ownerKey
      ? svc.from("ghl_opportunities").select("contact_id, stage_id, name").eq("owner_key", acct.ownerKey).limit(1000)
      : Promise.resolve({ data: [] as Array<{ contact_id: string; stage_id: string; name: string }> }),
    acct.ownerKey
      ? svc.from("ghl_contacts").select("id, contact_name").eq("owner_key", acct.ownerKey).limit(1000)
      : Promise.resolve({ data: [] as Array<{ id: string; contact_name: string }> }),
  ]);
  const stageOf = new Map((oppRows ?? []).map((r) => [r.contact_id as string, r.stage_id as string]));
  // Only a fraction of leads land in ghl_contacts, so fall back to the name on
  // the opportunity — otherwise most hits come back as raw ids and the answer
  // is unreadable.
  const nameOf = new Map<string, string>();
  for (const r of (oppRows ?? []) as Array<{ contact_id: string; name: string }>) {
    if (r.name) nameOf.set(r.contact_id, r.name);
  }
  for (const r of (contactRows ?? []) as Array<{ id: string; contact_name: string }>) {
    if (r.contact_name) nameOf.set(r.id, r.contact_name);
  }

  const stageNames = new Map<string, string>();
  const pj = await gget(`${GHL}/opportunities/pipelines?locationId=${acct.locationId}`, acct.token);
  for (const p of (pj?.pipelines as Array<Record<string, unknown>> | undefined) ?? []) {
    for (const s of (p.stages as Array<Record<string, unknown>> | undefined) ?? []) {
      stageNames.set(String(s.id), String(s.name ?? s.id));
    }
  }

  // How many conversations GHL actually has, so a partial sync can't be
  // reported as full coverage.
  const totalProbe = await gget(`${GHL}/conversations/search?locationId=${acct.locationId}&limit=1`, acct.token);
  const liveTotal = Number(totalProbe?.total ?? 0) || null;

  let scanned = 0;
  let stoppedEarly = false;
  const hits: ScanHit[] = [];
  await pool(convos, 6, async (c) => {
    if (Date.now() > deadline) { stoppedEarly = true; return; }
    const msgs = await messagesFor(c.id, acct.token);
    scanned++;
    const matches = msgs
      .filter((m) => {
        if (opts.direction === "inbound" && m.direction !== "inbound") return false;
        if (opts.direction === "outbound" && m.direction === "inbound") return false;
        return patterns.some((re) => re.test(m.body));
      })
      .map((m) => ({ at: m.at.slice(0, 10), who: m.direction === "inbound" ? "them" : "us", text: m.body.slice(0, 300) }));
    if (matches.length) {
      const sid = stageOf.get(c.contact_id);
      hits.push({
        contact: nameOf.get(c.contact_id) ?? c.contact_id,
        contactId: c.contact_id,
        stage: sid ? stageNames.get(sid) ?? sid : null,
        matches: matches.slice(0, 6),
      });
    }
  });

  return {
    account: acct.label,
    searchedFor: opts.contains,
    conversationsScanned: scanned,
    conversationsSynced: convos.length,
    conversationsInGhl: liveTotal,
    stoppedEarly,
    coverageNote: [
      stoppedEarly
        ? `Hit the time budget after ${scanned} of ${convos.length} conversations — offer to narrow the search.`
        : `Scanned ${scanned} conversations.`,
      liveTotal && liveTotal > convos.length
        ? `Only ${convos.length} of this account's ${liveTotal} conversations have synced to us, so older chats were NOT searched — state this plainly.`
        : "",
      "Anything agreed by phone or in person never appears in chat, so treat any count from this as a floor, not a total.",
    ].filter(Boolean).join(" "),
    hitCount: hits.length,
    hits: hits.slice(0, 60),
  };
}

// Who sits in which stage right now — the other half of a "what's missing?"
// question, so hits can be compared against the pipeline.
export async function pipelineContacts(acct: ChatAccount): Promise<Record<string, unknown>> {
  const svc = createServiceClient();
  const stageNames = new Map<string, string>();
  const pj = await gget(`${GHL}/opportunities/pipelines?locationId=${acct.locationId}`, acct.token);
  for (const p of (pj?.pipelines as Array<Record<string, unknown>> | undefined) ?? []) {
    for (const s of (p.stages as Array<Record<string, unknown>> | undefined) ?? []) {
      stageNames.set(String(s.id), String(s.name ?? s.id));
    }
  }
  if (!acct.ownerKey) return { error: "pipeline_contacts needs a client — the agency's own account has no lead pipeline" };
  const { data: rows, error } = await svc
    .from("ghl_opportunities").select("contact_id, stage_id, status")
    .eq("owner_key", acct.ownerKey).limit(1000);
  if (error) return { error: `couldn't read the pipeline: ${error.message}` };
  const { data: contactRows } = await svc
    .from("ghl_contacts").select("id, contact_name").eq("owner_key", acct.ownerKey).limit(1000);
  const nameOf = new Map((contactRows ?? []).map((r) => [r.id as string, r.contact_name as string]));

  const byStage = new Map<string, string[]>();
  for (const r of (rows ?? []) as Array<{ contact_id: string; stage_id: string }>) {
    const stage = stageNames.get(r.stage_id) ?? r.stage_id;
    const list = byStage.get(stage) ?? [];
    list.push(nameOf.get(r.contact_id) ?? r.contact_id);
    byStage.set(stage, list);
  }
  return {
    account: acct.label,
    total: (rows ?? []).length,
    stages: [...byStage.entries()].map(([stage, contacts]) => ({ stage, count: contacts.length, contacts: contacts.slice(0, 60) })),
  };
}
