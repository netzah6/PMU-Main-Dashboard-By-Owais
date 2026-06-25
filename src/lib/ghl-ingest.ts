import { createServiceClient } from "@/lib/supabase/server";
import { getSheetsClient } from "@/lib/sheets";

// ── V3 roster resolution (mirrors offers.ts) ─────────────────────────────────
function nameTokens(s: string): Set<string> {
  return new Set(String(s ?? "").toLowerCase().replace(/[^a-z]+/g, " ").split(" ").filter((t) => t.length >= 2));
}
function sameClient(a: Set<string>, b: Set<string>): boolean {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared >= 2 || (shared >= 1 && (a.size === 1 || b.size === 1));
}

export interface V3Account { ownerKey: string; locationId: string; token: string }

// Resolve the V3 sub-accounts from the keys sheet, keyed by the canonical
// v3_pricing OWNER/BUSINESS name so they line up with the rest of the dashboard.
export async function getV3Accounts(): Promise<V3Account[]> {
  const sheetId = process.env.GHL_KEYS_SHEET_ID;
  if (!sheetId) throw new Error("GHL_KEYS_SHEET_ID not set");
  const supabase = createServiceClient();

  // Roster = live/paused V3 clients from Clients Master. ownerKey = Owner Full
  // Name (lowercased) so it matches what the dashboard queries the box by.
  const bizNorm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const { data: cmRows } = await supabase.from("clients_master").select("data");
  const roster = (cmRows ?? [])
    .map((r) => r.data as Record<string, unknown>)
    .filter((d) => {
      const ver = String(d?.["Version"] ?? "").toLowerCase();
      const st = String(d?.["col_1"] ?? "").toLowerCase();
      return (ver.includes("v3") || ver.includes("v2.3")) && (st === "live" || st === "paused");
    })
    .map((d) => ({
      key: String(d["Owner Full Name"] ?? "").trim().toLowerCase(),
      tokens: nameTokens(String(d["Owner Full Name"] ?? "")),
      biz: bizNorm(String(d["Business Name"] ?? "")),
    }))
    .filter((c) => c.key);

  // Match a keys-sheet row to a client by name tokens, else by exact business name.
  const matchClient = (name: string, biz: string) => {
    const byName = roster.find((c) => sameClient(nameTokens(name), c.tokens));
    if (byName) return byName.key;
    const bn = bizNorm(biz);
    return bn ? roster.find((c) => c.biz && c.biz === bn)?.key ?? null : null;
  };

  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "Sheet1" });
  const rows = (res.data.values ?? []) as string[][];
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => String(h ?? "").toLowerCase());
  const nameIdx = header.findIndex((h) => /^name/.test(h.trim()));
  const bizIdx = header.findIndex((h) => /business/.test(h));
  const locIdx = header.findIndex((h) => /location/.test(h));
  const tokIdx = header.findIndex((h) => /integration|private|key|token/.test(h));

  const out: V3Account[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(1)) {
    const name = String(row[nameIdx] ?? "").trim();
    const biz = bizIdx >= 0 ? String(row[bizIdx] ?? "").trim() : "";
    const locationId = String(row[locIdx] ?? "").trim();
    const token = String(row[tokIdx] ?? "").trim();
    if (!locationId || !token) continue;
    const ownerKey = matchClient(name, biz);
    if (ownerKey && !seen.has(ownerKey)) { seen.add(ownerKey); out.push({ ownerKey, locationId, token }); }
  }
  return out;
}

// ── helpers ──────────────────────────────────────────────────────────────────
const BASE = "https://services.leadconnectorhq.com";

function toISO(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return new Date(v).toISOString();
  const s = String(v);
  if (/^\d+$/.test(s)) return new Date(Number(s)).toISOString();
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

async function ghlGet(url: string, token: string, version: string): Promise<Record<string, unknown> | null> {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Version: version, Accept: "application/json" } });
  if (!r.ok) return null;
  return (await r.json()) as Record<string, unknown>;
}

const MAX_PAGES = 30; // safety cap per resource per account (~3000 records)

export interface IngestStat { ownerKey: string; contacts: number; conversations: number; opportunities: number; error?: string }
export interface IngestOpts { sinceMs?: number; maxPages?: number; skipOpps?: boolean }

export async function ingestAccount(acct: V3Account, opts: IngestOpts = {}): Promise<IngestStat> {
  const supabase = createServiceClient();
  const { ownerKey, locationId, token } = acct;
  const stat: IngestStat = { ownerKey, contacts: 0, conversations: 0, opportunities: 0 };
  const now = new Date().toISOString();
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const since = opts.sinceMs;

  try {
    // ── Contacts (paginate via meta.nextPageUrl; incremental via startDate) ──
    let url: string | null = `${BASE}/contacts/?locationId=${locationId}&limit=100${since ? `&startDate=${since}&endDate=${Date.now()}` : ""}`;
    for (let p = 0; p < maxPages && url; p++) {
      const j = await ghlGet(url, token, "2021-07-28");
      if (!j) break;
      const contacts = (j.contacts as Record<string, unknown>[]) ?? [];
      if (contacts.length) {
        const rows = contacts.map((c) => ({
          id: String(c.id), location_id: locationId, owner_key: ownerKey,
          contact_name: (c.contactName ?? c.name ?? null) as string | null,
          email: (c.email ?? null) as string | null,
          phone: (c.phone ?? null) as string | null,
          source: (c.source ?? null) as string | null,
          type: (c.type ?? null) as string | null,
          assigned_to: (c.assignedTo ?? null) as string | null,
          date_added: toISO(c.dateAdded),
          raw: c, synced_at: now,
        }));
        await supabase.from("ghl_contacts").upsert(rows, { onConflict: "id" });
        stat.contacts += rows.length;
      }
      const meta = (j.meta as Record<string, unknown>) ?? {};
      url = (meta.nextPageUrl as string) ?? null;
      if (contacts.length < 100) break;
    }

    // ── Conversations (paginate via startAfterDate, desc) ──
    let startAfter: number | null = null;
    for (let p = 0; p < maxPages; p++) {
      const u = `${BASE}/conversations/search?locationId=${locationId}&limit=100&sortBy=last_message_date&sort=desc${startAfter ? `&startAfterDate=${startAfter}` : ""}`;
      const j = await ghlGet(u, token, "2021-04-15");
      if (!j) break;
      const convos = (j.conversations as Record<string, unknown>[]) ?? [];
      if (!convos.length) break;
      const rows = convos.map((c) => ({
        id: String(c.id), location_id: locationId, owner_key: ownerKey,
        contact_id: (c.contactId ?? null) as string | null,
        last_message_date: toISO(c.lastMessageDate),
        last_message_direction: (c.lastMessageDirection ?? null) as string | null,
        last_message_type: (c.lastMessageType ?? null) as string | null,
        last_message_body: (c.lastMessageBody ?? null) as string | null,
        unread_count: (typeof c.unreadCount === "number" ? c.unreadCount : null) as number | null,
        date_added: toISO(c.dateAdded),
        date_updated: toISO(c.dateUpdated),
        raw: c, synced_at: now,
      }));
      await supabase.from("ghl_conversations").upsert(rows, { onConflict: "id" });
      stat.conversations += rows.length;
      const last = convos[convos.length - 1];
      const lmd = Number(last.lastMessageDate);
      if (!lmd || convos.length < 100) break;
      if (since && lmd < since) break; // incremental: stop once older than cutoff
      startAfter = lmd;
    }

    // ── Opportunities (paginate via meta.nextPageUrl) ──
    let ourl: string | null = opts.skipOpps ? null : `${BASE}/opportunities/search?location_id=${locationId}&limit=100`;
    for (let p = 0; p < maxPages && ourl; p++) {
      const j = await ghlGet(ourl, token, "2021-07-28");
      if (!j) break;
      const opps = (j.opportunities as Record<string, unknown>[]) ?? [];
      if (opps.length) {
        const rows = opps.map((o) => ({
          id: String(o.id), location_id: locationId, owner_key: ownerKey,
          contact_id: ((o.contact as Record<string, unknown>)?.id ?? o.contactId ?? null) as string | null,
          name: (o.name ?? null) as string | null,
          pipeline_id: (o.pipelineId ?? null) as string | null,
          stage_id: (o.pipelineStageId ?? null) as string | null,
          status: (o.status ?? null) as string | null,
          monetary_value: (typeof o.monetaryValue === "number" ? o.monetaryValue : null) as number | null,
          source: (o.source ?? null) as string | null,
          date_added: toISO(o.createdAt ?? o.dateAdded),
          last_stage_change_at: toISO(o.lastStageChangeAt),
          raw: o, synced_at: now,
        }));
        await supabase.from("ghl_opportunities").upsert(rows, { onConflict: "id" });
        stat.opportunities += rows.length;
      }
      const meta = (j.meta as Record<string, unknown>) ?? {};
      ourl = (meta.nextPageUrl as string) ?? null;
      if (opps.length < 100) break;
    }
  } catch (err) {
    stat.error = String(err);
  }
  return stat;
}

// Run an async worker over items with a max number running at once.
async function mapWithConcurrency<I, O>(items: I[], limit: number, worker: (item: I) => Promise<O>): Promise<O[]> {
  const results = new Array<O>(items.length);
  let next = 0;
  async function lane() { while (next < items.length) { const i = next++; results[i] = await worker(items[i]); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => lane()));
  return results;
}

export async function ingestAllV3(opts: IngestOpts = {}): Promise<{ accounts: number; stats: IngestStat[] }> {
  const accts = await getV3Accounts();
  const stats = await mapWithConcurrency(accts, 4, (a) => ingestAccount(a, opts));
  return { accounts: accts.length, stats };
}
