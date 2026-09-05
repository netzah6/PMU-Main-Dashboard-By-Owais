import { createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken } from "@/lib/ghl-app";

// Text-blast helpers (admin Blast tab). The AI tab has NO access to any of
// this — blasts are composed and confirmed by a human, and sending happens
// in the blast-send cron.

const GHL = "https://services.leadconnectorhq.com";

export const DEFAULT_TEMPLATE =
  "Hey {{contact.first_name}}, It’s {{user.first_name}}! \n\n" +
  "I just had 3 spots open up for {{service}} appointments this week. " +
  "Would you like to book one of them?";

/** "microblading" if the client's PMU Services mention it, else the generic. */
export function serviceWordFor(pmuServices: string | null | undefined): string {
  return /microblad/i.test(String(pmuServices ?? "")) ? "microblading" : "permanent makeup eyebrows";
}

export function renderTemplate(tpl: string, vars: { firstName: string; senderName: string; service: string }): string {
  return tpl
    .replaceAll("{{contact.first_name}}", vars.firstName || "there")
    .replaceAll("{{user.first_name}}", vars.senderName)
    .replaceAll("{{service}}", vars.service);
}

export interface BlastRecipient { contactId: string; name: string; firstName: string; phone: string }

export const MAX_BLAST_CONTACTS = 250;

/** Map contactId -> last conversation activity (ms epoch), from the live
 * conversations list (any direction — "we engaged" includes their replies). */
async function lastEngagement(locationId: string, token: string): Promise<Map<string, number>> {
  const H = { Authorization: `Bearer ${token}`, Version: "2021-04-15", Accept: "application/json" };
  const out = new Map<string, number>();
  let startAfter: number | null = null;
  for (let p = 0; p < 30; p++) {
    const u: string = `${GHL}/conversations/search?locationId=${locationId}&limit=100&sortBy=last_message_date&sort=desc${startAfter ? `&startAfterDate=${startAfter}` : ""}`;
    const res: Response = await fetch(u, { headers: H });
    if (!res.ok) break;
    const j: Record<string, unknown> = await res.json();
    const convos = (j.conversations as Array<Record<string, unknown>>) ?? [];
    if (!convos.length) break;
    for (const c of convos) {
      const cid = String(c.contactId ?? "");
      const at = Number(c.lastMessageDate ?? 0);
      if (cid && at && (out.get(cid) ?? 0) < at) out.set(cid, at);
    }
    const lmd = Number(convos[convos.length - 1].lastMessageDate);
    if (!lmd || convos.length < 100) break;
    startAfter = lmd;
    await new Promise((r) => setTimeout(r, 100));
  }
  return out;
}

/** Live audience fetch: contacts holding an opportunity in any selected stage,
 * phone required, deduped by phone, anyone with conversation activity in the
 * last `excludeDays` days excluded, capped at `maxContacts` keeping the most
 * recently engaged (outside the window) first — never-contacted leads last. */
export async function fetchAudience(
  locationId: string,
  pipelineId: string,
  stageIds: string[],
  excludeDays = 10,
  maxContacts = MAX_BLAST_CONTACTS,
): Promise<{ recipients: BlastRecipient[]; noPhone: number; eligible: number; excludedRecent: number; error?: string }> {
  const cap = Math.max(1, Math.min(MAX_BLAST_CONTACTS, Math.floor(maxContacts) || MAX_BLAST_CONTACTS));
  const tok = await getAppLocationToken(locationId);
  if (!tok.token) return { recipients: [], noPhone: 0, eligible: 0, excludedRecent: 0, error: tok.error ?? "no token" };
  const H = { Authorization: `Bearer ${tok.token}`, Version: "2021-07-28", Accept: "application/json" };
  const engaged = await lastEngagement(locationId, tok.token);
  const cutoff = Date.now() - excludeDays * 86400000;
  let excludedRecent = 0;
  const out: Array<BlastRecipient & { lastAt: number }> = [];
  const seenPhones = new Set<string>();
  const seenContacts = new Set<string>();
  let noPhone = 0;
  for (const stageId of stageIds) {
    let page = `${GHL}/opportunities/search?location_id=${locationId}&pipeline_id=${pipelineId}&pipeline_stage_id=${stageId}&limit=100`;
    for (let p = 0; p < 10 && page; p++) {
      const res = await fetch(page, { headers: H });
      if (!res.ok) return { recipients: [], noPhone, eligible: out.length, excludedRecent, error: `opportunities HTTP ${res.status}` };
      const j = await res.json();
      const opps = (j.opportunities as Array<Record<string, unknown>>) ?? [];
      for (const o of opps) {
        const contactId = String(o.contactId ?? "");
        if (!contactId || seenContacts.has(contactId)) continue;
        seenContacts.add(contactId);
        const c = (o.contact ?? {}) as Record<string, unknown>;
        let phone = String(c.phone ?? "").trim();
        let name = String(c.name ?? o.name ?? "").trim();
        let firstName = String(c.firstName ?? "").trim();
        if (!phone) {
          // The embedded contact often omits phone — check the full record.
          const cr = await fetch(`${GHL}/contacts/${contactId}`, { headers: H });
          if (cr.ok) {
            const cj = (await cr.json()).contact ?? {};
            phone = String(cj.phone ?? "").trim();
            if (!name) name = String(cj.name ?? `${cj.firstName ?? ""} ${cj.lastName ?? ""}`).trim();
            if (!firstName) firstName = String(cj.firstName ?? "").trim();
          }
          await new Promise((r) => setTimeout(r, 80));
        }
        if (!phone) { noPhone++; continue; }
        if (seenPhones.has(phone)) continue;
        seenPhones.add(phone);
        if (!firstName) firstName = name.split(/\s+/)[0] ?? "";
        const lastAt = engaged.get(contactId) ?? 0;
        if (lastAt >= cutoff) { excludedRecent++; continue; }
        out.push({ contactId, name: name || firstName || "(no name)", firstName, phone, lastAt });
      }
      page = ((j.meta as Record<string, unknown>)?.nextPageUrl as string) ?? null;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  // Warmest first: most recent engagement outside the window; never-contacted
  // (lastAt 0) land at the end. Then apply the cap.
  out.sort((a, b) => b.lastAt - a.lastAt);
  const recipients = out.slice(0, cap).map((r) => ({ contactId: r.contactId, name: r.name, firstName: r.firstName, phone: r.phone }));
  return { recipients, noPhone, eligible: out.length, excludedRecent };
}

/** Send one SMS through the conversations API. Needs the
 * conversations/message.write scope on the marketplace app. */
export async function sendSms(
  token: string,
  contactId: string,
  message: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${GHL}/conversations/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Version: "2021-04-15", "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ type: "SMS", contactId, message }),
  });
  if (res.ok) return { ok: true };
  const text = await res.text().catch(() => "");
  return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 180)}` };
}

/** Pipeline ids the sub-account actually has RIGHT NOW. The cached stage map
 * can still hold a previous owner's pipeline on a recycled sub-account, so the
 * stage picker is filtered against this before anyone builds an audience.
 * Returns null when GHL can't be reached — callers then trust the cache. */
export async function livePipelineIds(locationId: string): Promise<Set<string> | null> {
  const tok = await getAppLocationToken(locationId);
  if (!tok.token) return null;
  try {
    const r = await fetch(`https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${locationId}`, {
      headers: { Authorization: `Bearer ${tok.token}`, Version: "2021-07-28", Accept: "application/json" },
      cache: "no-store",
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { pipelines?: Array<{ id?: string }> };
    const ids = (j.pipelines ?? []).map((p) => String(p.id ?? "")).filter(Boolean);
    return ids.length ? new Set(ids) : null;
  } catch { return null; }
}

/** Clients an admin can blast for: synced sub-accounts joined to the master
 * sheet for business name + PMU services. */
export async function blastClients(): Promise<Array<{ locationId: string; ownerKey: string; label: string; senderFirstName: string; serviceWord: string }>> {
  const svc = createServiceClient();
  const [{ data: sync }, { data: master }] = await Promise.all([
    svc.from("ghl_sync_status").select("owner_key,location_id,last_success_at").not("location_id", "is", null),
    svc.from("clients_master").select("data"),
  ]);
  const rows = (master ?? []) as Array<{ data: Record<string, unknown> }>;
  const byOwner = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const key = String(r.data["Owner Full Name"] ?? "").trim().toLowerCase();
    if (key) byOwner.set(key, r.data);
  }
  const built = (sync ?? []).map((s) => {
    const m = byOwner.get(String(s.owner_key).trim().toLowerCase());
    const biz = String(m?.["Business Name"] ?? "").trim();
    const owner = String(m?.["Owner Full Name"] ?? s.owner_key).trim();
    return {
      locationId: s.location_id as string,
      ownerKey: s.owner_key as string,
      label: biz ? `${biz} — ${owner}` : owner,
      senderFirstName: owner.split(/\s+/)[0] ?? "",
      serviceWord: serviceWordFor(String(m?.["PMU Services"] ?? "")),
      status: String(m?.col_1 ?? "").trim().toLowerCase(),
      lastSync: String(s.last_success_at ?? ""),
    };
  });

  // Sub-accounts get recycled: an offboarded client's account is wiped, renamed
  // and handed to a new client, but the OLD owner's ghl_sync_status row still
  // points at it. That put two entries on the same location in the picker
  // ("Daniela Bell" and "Orna Weisberg" — user report 2026-09-05), so choosing
  // one could blast through the other's identity. Keep one entry per location:
  // a still-active client wins over an offboarded/lost one, then the most
  // recently synced.
  const dead = (s: string) => s === "offboarded" || s === "lost";
  const best = new Map<string, (typeof built)[number]>();
  for (const c of built) {
    const prev = best.get(c.locationId);
    if (!prev) { best.set(c.locationId, c); continue; }
    const better =
      dead(prev.status) !== dead(c.status)
        ? !dead(c.status)
        : c.lastSync.localeCompare(prev.lastSync) > 0;
    if (better) best.set(c.locationId, c);
  }
  return [...best.values()]
    .filter((c) => !dead(c.status))
    .map(({ status: _status, lastSync: _lastSync, ...c }) => c)
    .sort((a, b) => a.label.localeCompare(b.label));
}
