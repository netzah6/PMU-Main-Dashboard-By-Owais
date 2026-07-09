import { createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken } from "@/lib/ghl-app";

// Per-client report data for the Ask AI tab. Combines what's in Supabase
// (contacts, conversations, opportunities) with live GHL fetches for the
// pieces we don't store: pipeline stage NAMES, message-level call history,
// and the client's strategy-call appointments in the agency sub-account.

const GHL = "https://services.leadconnectorhq.com";
const V = "2021-07-28";
const PMU_BOD_LOCATION = "SfpNMJ5YU9lBkxss47lK"; // agency account (read-only here)
const CONVERSATION_SAMPLE = 120;
const CONCURRENCY = 8;

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

function localHour(iso: string, tz: string | null): number | null {
  try {
    return Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz ?? "America/New_York" }).format(new Date(iso)));
  } catch { return null; }
}
function localDay(iso: string, tz: string | null): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz ?? "America/New_York" }).format(new Date(iso));
  } catch { return iso.slice(0, 10); }
}
function isWeekend(iso: string, tz: string | null): boolean {
  try {
    const wd = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz ?? "America/New_York" }).format(new Date(iso));
    return wd === "Sat" || wd === "Sun";
  } catch { return false; }
}

type Ev = { contactId: string; t: number; iso: string; call: boolean; outbound: boolean; channel: "call" | "sms" | "email" | "other" };

export async function buildClientReport(nameQuery: string): Promise<Record<string, unknown>> {
  const svc = createServiceClient();
  const q = nameQuery.trim();

  // 1. Resolve the client from the master sheet.
  const { data: masters } = await svc
    .from("clients_master")
    .select("data")
    .or(`data->>Owner Full Name.ilike.%${q}%,data->>Business Name.ilike.%${q}%`)
    .limit(5);
  const rows = (masters ?? []).map((r) => r.data as Record<string, string>);
  const master = rows.find((d) => (d["col_1"] ?? "") === "Live") ?? rows[0];
  if (!master) return { error: `No client found matching "${q}" in the master sheet.` };
  const owner = String(master["Owner Full Name"] ?? "").trim();
  const business = String(master["Business Name"] ?? "").trim();
  const ownerKey = owner.toLowerCase();
  const client = {
    owner, business,
    status: master["col_1"] ?? "", version: master["Version"] ?? "",
    assigned: master["Assigned"] ?? "",
  };

  // 2. Their sub-account (from ingested contacts).
  const { data: locRow } = await svc.from("ghl_contacts").select("location_id").eq("owner_key", ownerKey).limit(1);
  const locationId = locRow?.[0]?.location_id as string | undefined;
  if (!locationId) {
    return { client, error: "This client's GHL sub-account is not ingested (no key/app data) — pipeline and call metrics unavailable." };
  }
  const tok = await getAppLocationToken(locationId);
  const caveats: string[] = [];

  // 3. Timezone + pipeline stage names (live).
  let tz: string | null = null;
  const stageNames = new Map<string, string>();
  if (tok.token) {
    const loc = await gget(`${GHL}/locations/${locationId}`, tok.token);
    tz = ((loc?.location as Record<string, unknown>)?.timezone as string) ?? null;
    const pj = await gget(`${GHL}/opportunities/pipelines?locationId=${locationId}`, tok.token);
    for (const p of (pj?.pipelines as Array<Record<string, unknown>> | undefined) ?? []) {
      for (const s of (p.stages as Array<Record<string, unknown>> | undefined) ?? []) {
        stageNames.set(String(s.id), String(s.name ?? s.id));
      }
    }
  } else {
    caveats.push(`No app token for the sub-account (${tok.error}) — stage names and call history unavailable.`);
  }

  // 4. Pipeline distribution (DB counts + live names).
  const { data: stageRows } = await svc.rpc("ask_ai_query", {
    q: `SELECT stage_id, status, count(*)::int AS n FROM ghl_opportunities WHERE owner_key = '${ownerKey.replace(/'/g, "''")}' GROUP BY stage_id, status`,
  });
  const pipeline = ((stageRows as Array<{ stage_id: string; status: string; n: number }>) ?? []).map((r) => ({
    stage: stageNames.get(r.stage_id) ?? r.stage_id,
    status: r.status,
    leads: r.n,
  }));

  // 5. Call/chat history: sample recent conversations, fetch their messages.
  const { data: convs } = await svc
    .from("ghl_conversations")
    .select("id, contact_id")
    .eq("owner_key", ownerKey)
    .order("last_message_date", { ascending: false })
    .limit(CONVERSATION_SAMPLE);
  const convList = (convs ?? []) as Array<{ id: string; contact_id: string | null }>;

  const contactIds = Array.from(new Set(convList.map((c) => c.contact_id).filter(Boolean))) as string[];
  const addedMap = new Map<string, string>();
  for (let i = 0; i < contactIds.length; i += 200) {
    const { data: cd } = await svc.from("ghl_contacts").select("id, date_added").in("id", contactIds.slice(i, i + 200));
    for (const c of (cd ?? []) as Array<{ id: string; date_added: string | null }>) {
      if (c.date_added) addedMap.set(c.id, c.date_added);
    }
  }

  const events: Ev[] = [];
  if (tok.token) {
    await pool(convList, CONCURRENCY, async (c) => {
      const j = await gget(`${GHL}/conversations/${c.id}/messages?limit=100`, tok.token!);
      const wrap = (j?.messages ?? {}) as Record<string, unknown>;
      const msgs = (Array.isArray(wrap) ? wrap : (wrap.messages as Array<Record<string, unknown>>)) ?? [];
      for (const m of msgs) {
        const iso = String(m.dateAdded ?? m.date_added ?? "");
        if (!iso || !c.contact_id) continue;
        const mt = String(m.messageType ?? m.type ?? "");
        const isCall = /CALL|VOICEMAIL/i.test(mt);
        events.push({
          contactId: c.contact_id,
          t: Date.parse(iso), iso,
          call: isCall,
          outbound: String(m.direction ?? "").toLowerCase() === "outbound",
          channel: isCall ? "call" : /SMS|WHATSAPP|GMB|FB|IG|LIVE_CHAT/i.test(mt) ? "sms" : /EMAIL/i.test(mt) ? "email" : "other",
        });
      }
      return null;
    });
    caveats.push(`Call/chat behavior computed from the ${convList.length} most recent conversations (message history isn't stored, it was fetched live).`);
  }

  // 6. Behavior analytics.
  const byContact = new Map<string, Ev[]>();
  for (const e of events) {
    if (!byContact.has(e.contactId)) byContact.set(e.contactId, []);
    byContact.get(e.contactId)!.push(e);
  }
  for (const list of byContact.values()) list.sort((a, b) => a.t - b.t);

  let outCalls = 0, outMsgs = 0;
  const hourHist: Record<number, number> = {};
  let calledContacts = 0, doubleCallContacts = 0;
  let within24 = 0, within24Base = 0;
  let followBase = 0, follow3days = 0;

  for (const [cid, list] of byContact) {
    const calls = list.filter((e) => e.call && e.outbound);
    const msgs = list.filter((e) => !e.call && e.outbound);
    outCalls += calls.length; outMsgs += msgs.length;
    for (const c of calls) { const h = localHour(c.iso, tz); if (h != null) hourHist[h] = (hourHist[h] ?? 0) + 1; }
    if (calls.length) {
      calledContacts++;
      for (let i = 1; i < calls.length; i++) {
        if (calls[i].t - calls[i - 1].t <= 20 * 60 * 1000) { doubleCallContacts++; break; }
      }
      const added = addedMap.get(cid);
      if (added && !isWeekend(added, tz)) {
        within24Base++;
        if (calls[0].t - Date.parse(added) <= 24 * 3600 * 1000) within24++;
      }
    }
    // Follow-up persistence: distinct local days with outbound attempts in the
    // lead's first 7 days, for leads that never wrote back in that window.
    const added = addedMap.get(cid);
    if (added) {
      const t0 = Date.parse(added);
      const week = list.filter((e) => e.t - t0 <= 7 * 24 * 3600 * 1000);
      const inboundInWeek = week.some((e) => !e.outbound);
      const outDays = new Set(week.filter((e) => e.outbound).map((e) => localDay(e.iso, tz)));
      if (!inboundInWeek && outDays.size >= 1) {
        followBase++;
        if (outDays.size >= 3) follow3days++;
      }
    }
  }
  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : null);
  const calls1719 = (hourHist[17] ?? 0) + (hourHist[18] ?? 0);
  const callsTotalHist = Object.values(hourHist).reduce((s, n) => s + n, 0);

  // 7. Strategy calls — the client's contact in the agency sub-account.
  let strategy: unknown = "no contact ID on the master sheet";
  const masterContactId = String(master["Contact ID"] ?? "").trim();
  if (masterContactId) {
    const agencyTok = await getAppLocationToken(PMU_BOD_LOCATION);
    if (agencyTok.token) {
      const aj = await gget(`${GHL}/contacts/${masterContactId}/appointments`, agencyTok.token);
      const evs = ((aj?.events ?? aj?.appointments) as Array<Record<string, unknown>> | undefined) ?? [];
      strategy = evs
        .map((e) => ({ title: String(e.title ?? ""), start: String(e.startTime ?? e.start_time ?? ""), status: String(e.appointmentStatus ?? e.status ?? "") }))
        .sort((a, b) => (a.start < b.start ? 1 : -1))
        .slice(0, 8);
    } else {
      strategy = `agency sub-account token unavailable (${agencyTok.error})`;
    }
  }

  return {
    client,
    timezone: tz,
    pipeline: { total: pipeline.reduce((s, p) => s + p.leads, 0), stages: pipeline },
    behavior: {
      sampledConversations: convList.length,
      outboundCalls: outCalls,
      outboundMessages: outMsgs,
      outboundByChannel: events.filter((e) => e.outbound).reduce<Record<string, number>>((acc, e) => {
        acc[e.channel] = (acc[e.channel] ?? 0) + 1;
        return acc;
      }, {}),
      contactsWithAnyCall: calledContacts,
      contactsSampled: byContact.size,
      doubleCallRatePct: pct(doubleCallContacts, calledContacts),
      firstCallWithin24hPct: pct(within24, within24Base),
      firstCallWithin24hBase: within24Base,
      callsBetween5and7pmPct: pct(calls1719, callsTotalHist),
      callsByLocalHour: hourHist,
      followedUp3PlusDaysPct: pct(follow3days, followBase),
      followupBase: followBase,
    },
    strategyAppointments: strategy,
    caveats,
  };
}
