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

/** Live audience fetch: contacts holding an opportunity in any selected stage,
 * phone required, deduped by phone. */
export async function fetchAudience(
  locationId: string,
  pipelineId: string,
  stageIds: string[],
): Promise<{ recipients: BlastRecipient[]; noPhone: number; error?: string }> {
  const tok = await getAppLocationToken(locationId);
  if (!tok.token) return { recipients: [], noPhone: 0, error: tok.error ?? "no token" };
  const H = { Authorization: `Bearer ${tok.token}`, Version: "2021-07-28", Accept: "application/json" };
  const out: BlastRecipient[] = [];
  const seenPhones = new Set<string>();
  const seenContacts = new Set<string>();
  let noPhone = 0;
  for (const stageId of stageIds) {
    let page = `${GHL}/opportunities/search?location_id=${locationId}&pipeline_id=${pipelineId}&pipeline_stage_id=${stageId}&limit=100`;
    for (let p = 0; p < 10 && page; p++) {
      const res = await fetch(page, { headers: H });
      if (!res.ok) return { recipients: out, noPhone, error: `opportunities HTTP ${res.status}` };
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
        out.push({ contactId, name: name || firstName || "(no name)", firstName, phone });
      }
      page = ((j.meta as Record<string, unknown>)?.nextPageUrl as string) ?? null;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return { recipients: out, noPhone };
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

/** Clients an admin can blast for: synced sub-accounts joined to the master
 * sheet for business name + PMU services. */
export async function blastClients(): Promise<Array<{ locationId: string; ownerKey: string; label: string; senderFirstName: string; serviceWord: string }>> {
  const svc = createServiceClient();
  const [{ data: sync }, { data: master }] = await Promise.all([
    svc.from("ghl_sync_status").select("owner_key,location_id").not("location_id", "is", null),
    svc.from("clients_master").select("data"),
  ]);
  const rows = (master ?? []) as Array<{ data: Record<string, unknown> }>;
  const byOwner = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const key = String(r.data["Owner Full Name"] ?? "").trim().toLowerCase();
    if (key) byOwner.set(key, r.data);
  }
  return (sync ?? [])
    .map((s) => {
      const m = byOwner.get(String(s.owner_key).trim().toLowerCase());
      const biz = String(m?.["Business Name"] ?? "").trim();
      const owner = String(m?.["Owner Full Name"] ?? s.owner_key).trim();
      return {
        locationId: s.location_id as string,
        ownerKey: s.owner_key as string,
        label: biz ? `${biz} — ${owner}` : owner,
        senderFirstName: owner.split(/\s+/)[0] ?? "",
        serviceWord: serviceWordFor(String(m?.["PMU Services"] ?? "")),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}
