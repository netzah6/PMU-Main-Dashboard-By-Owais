import type { SupabaseClient } from "@supabase/supabase-js";
import { getAppLocationToken } from "@/lib/ghl-app";
import { resolveClientLocation } from "@/lib/agent-exec";
import { fileOrAppendAlert, ghlContactUrl } from "@/lib/alerts";

// ── Paid-deposit safety net (owner, 2026-10-11) ──────────────────────────────
// A Fanbasis payment reaches the client's GHL through the "FanBasis to GHL
// workflow" (find contact by email → tag "fanbasis buyer" → …). About 1 in 10
// times since mid-September the payment reached our Deposits sheet but the
// contact never got the tag — Savannah Stidham (Eye Select Beauty) paid, and
// her appointment was marked INVALID 10 minutes later. Every 10 minutes this
// checks each new deposit: if the payer's contact has neither "fanbasis
// buyer" nor "deposit collected", it adds "fanbasis buyer" — the same tag the
// workflow adds — so the normal paid flow runs (confirms the appointment,
// moves the stage, AI off). Each payment is handled once and lands on the
// Alerts board so the team sees it happened.

type Svc = SupabaseClient;
const GHL = "https://services.leadconnectorhq.com";
const PAID_TAGS = ["fanbasis buyer", "deposit collected"];
const GRACE_MS = 15 * 60_000;          // let the normal flow finish first
const NOT_FOUND_GIVE_UP_MS = 3 * 3600_000;

const normBiz = (s: unknown) => String(s ?? "").toLowerCase().replace(/\b(llc|inc|co)\b/g, "").replace(/[^a-z0-9]+/g, "");
function depositDay(v: unknown): number {
  const m = String(v ?? "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // sheet dates are DD/MM/YYYY
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) : 0;
}

export async function healPaidTags(svc: Svc): Promise<{ checked: number; healed: string[]; notFound: string[]; errors: string[] }> {
  const healed: string[] = [], notFound: string[] = [], errors: string[] = [];
  const since = new Date(Date.now() - 48 * 3600_000).toISOString();
  const { data: rows } = await svc.from("deposits").select("data, synced_at").gte("synced_at", since);
  const recentDay = Date.now() - 3 * 86_400_000;
  const deps = ((rows ?? []) as Array<{ data: Record<string, unknown>; synced_at: string }>).filter((r) =>
    depositDay(r.data["Date"]) >= recentDay - 86_400_000 // only real new payments, not bulk re-syncs of old rows
    && Date.now() - Date.parse(r.synced_at) >= GRACE_MS
    && !/demo/i.test(String(r.data["Business Name"] ?? ""))
    && String(r.data["Email"] ?? "").includes("@"));
  if (!deps.length) return { checked: 0, healed, notFound, errors };

  const { data: ob } = await svc.from("onebox_clients").select("location_id, client_name");
  const locByBiz = new Map(((ob ?? []) as Array<{ location_id: string; client_name: string }>).map((o) => [normBiz(o.client_name), o.location_id]));
  const { data: cm } = await svc.from("clients_master").select("data");
  const ownerByBiz = new Map(((cm ?? []) as Array<{ data: Record<string, unknown> }>).map((r) => [normBiz(r.data["Business Name"]), String(r.data["Owner Full Name"] ?? "")]));

  let checked = 0;
  for (const r of deps) {
    const email = String(r.data["Email"]).trim().toLowerCase();
    const biz = String(r.data["Business Name"] ?? "").trim();
    const name = String(r.data["Full Name"] ?? email);
    const key = `${email}|${normBiz(biz)}|${r.data["Date"]}`;
    const { data: prev } = await svc.from("paid_tag_checks").select("result, attempts").eq("key", key).maybeSingle();
    const p = prev as { result: string; attempts: number } | null;
    if (p && p.result !== "not_found") continue;
    checked++;
    try {
      let loc = locByBiz.get(normBiz(biz)) ?? null;
      if (!loc && ownerByBiz.get(normBiz(biz))) loc = (await resolveClientLocation(svc, null, ownerByBiz.get(normBiz(biz))!).catch(() => null))?.locationId ?? null;
      if (!loc) { await svc.from("paid_tag_checks").upsert({ key, result: "no_location", checked_at: new Date().toISOString() }); continue; }
      const tok = await getAppLocationToken(loc);
      if (!tok.token) { errors.push(`${biz}: ${tok.error}`); continue; }
      const H = { Authorization: `Bearer ${tok.token}`, Version: "2021-07-28", Accept: "application/json", "Content-Type": "application/json" };
      const s = await fetch(`${GHL}/contacts/search`, { method: "POST", headers: H, body: JSON.stringify({ locationId: loc, pageLimit: 5, filters: [{ field: "email", operator: "eq", value: email }] }) });
      if (!s.ok) { errors.push(`${biz}: search HTTP ${s.status}`); continue; }
      const contacts = ((await s.json()) as { contacts?: Array<{ id: string; tags?: string[] }> }).contacts ?? [];
      if (!contacts.length) {
        const giveUp = Date.now() - Date.parse(r.synced_at) > NOT_FOUND_GIVE_UP_MS;
        await svc.from("paid_tag_checks").upsert({ key, location_id: loc, result: giveUp ? "not_found_final" : "not_found", attempts: (p?.attempts ?? 0) + 1, checked_at: new Date().toISOString() });
        if (giveUp) {
          notFound.push(`${name} (${biz})`);
          await fileOrAppendAlert(svc, {
            type: "paid_not_synced", severity: "high",
            title: `${name} paid a deposit to ${biz}, but no GHL contact has that email`,
            detail: `Payment ${r.data["Amount"] ?? ""} on ${r.data["Date"]} (${email}) never matched a contact in the client's GoHighLevel. Find her by name/phone, add the email and the "fanbasis buyer" tag.`,
            source_key: `paid-notfound:${key}`, meta: { location_id: loc, email },
          });
        }
        continue;
      }
      const paid = contacts.find((c) => (c.tags ?? []).some((t) => PAID_TAGS.includes(t.toLowerCase())));
      if (paid) { await svc.from("paid_tag_checks").upsert({ key, location_id: loc, contact_id: paid.id, result: "ok", checked_at: new Date().toISOString() }); continue; }
      const c = contacts[0];
      const t = await fetch(`${GHL}/contacts/${c.id}/tags`, { method: "POST", headers: H, body: JSON.stringify({ tags: ["fanbasis buyer"] }) });
      if (!t.ok) { errors.push(`${biz}: tag HTTP ${t.status}`); continue; }
      await svc.from("paid_tag_checks").upsert({ key, location_id: loc, contact_id: c.id, result: "healed", checked_at: new Date().toISOString() });
      healed.push(`${name} (${biz})`);
      await fileOrAppendAlert(svc, {
        type: "paid_not_synced", severity: "medium",
        title: `${name} paid ${biz} but GHL missed it — fixed automatically`,
        detail: `Payment ${r.data["Amount"] ?? ""} on ${r.data["Date"]} reached the Deposits sheet but not her GHL contact. The "fanbasis buyer" tag was added, so the paid-deposit workflow now confirms her appointment. Resolve this once checked.`,
        source_key: `paid-healed:${key}`, meta: { location_id: loc, contact_id: c.id, link: ghlContactUrl(loc, c.id) },
      });
    } catch (e) {
      errors.push(`${biz}: ${e instanceof Error ? e.message.slice(0, 100) : "error"}`);
    }
  }
  return { checked, healed, notFound, errors };
}
