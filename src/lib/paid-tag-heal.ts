import type { SupabaseClient } from "@supabase/supabase-js";
import { getAppLocationToken } from "@/lib/ghl-app";
import { resolveClientLocation } from "@/lib/agent-exec";
import { fileOrAppendAlert, filePaidNotBookedAlert, ghlContactUrl, resolvePaidNotBookedAlert } from "@/lib/alerts";
import { REMOVED_TAG, removedHoldTime } from "@/lib/ai-hold-cleanup";
import { lookBeforePaidBooking } from "@/lib/paid-booking";

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

const usDate = (v: unknown) => { const m = String(v ?? "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? `${m[2].padStart(2, "0")}/${m[1].padStart(2, "0")}/${m[3]}` : String(v ?? ""); };
const normName = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z]+/g, " ").trim();
type GContact = { id: string; phone?: string | null; tags?: string[]; firstName?: string; lastName?: string; contactName?: string; dateAdded?: string };
const isPaid = (c: GContact) => (c.tags ?? []).some((t) => PAID_TAGS.includes(t.toLowerCase()));

/* Which contact the payment belongs to (owner 10/25/2026: Andrea, Yvette,
   Marita paid with an email that wasn't on their lead — GHL filed each
   payment on a blank new contact with no phone, the real lead with the
   appointment never got "paid", so no confirmation or reminders).
   Only a contact WITH a phone counts as the lead: first by email, else the
   one recent lead with exactly her name. */
export async function findPaidTarget(H: Record<string, string>, loc: string, email: string, name: string): Promise<
  { kind: "ok" | "tag"; contact: GContact; byName: boolean } | { kind: "none" } | { kind: "ambiguous"; candidates: GContact[] }> {
  const search = async (body: Record<string, unknown>) => {
    const r = await fetch(`${GHL}/contacts/search`, { method: "POST", headers: H, body: JSON.stringify({ locationId: loc, pageLimit: 20, ...body }) });
    if (!r.ok) throw new Error(`search HTTP ${r.status}`);
    return ((await r.json()) as { contacts?: GContact[] }).contacts ?? [];
  };
  const byEmail = (await search({ filters: [{ field: "email", operator: "eq", value: email }] })).filter((c) => c.phone);
  if (byEmail.length) { const paid = byEmail.find(isPaid); return { kind: paid ? "ok" : "tag", contact: paid ?? byEmail[0], byName: false }; }
  const want = normName(name);
  if (!want || !want.includes(" ")) return { kind: "none" };
  const named = (await search({ query: name })).filter((c) => c.phone && normName(c.contactName ?? `${c.firstName ?? ""} ${c.lastName ?? ""}`) === want);
  // Recent leads first (60 days). An older lead counts only when she is the
  // ONE lead with that name in the last year (owner 10/30/2026: Jennifer
  // Winstanley, a 07/28 lead, paid in October with a different email).
  const recent = named.filter((c) => Date.parse(c.dateAdded ?? "") >= Date.now() - 60 * 86_400_000);
  const yearOld = named.filter((c) => Date.parse(c.dateAdded ?? "") >= Date.now() - 365 * 86_400_000);
  const same = recent.length ? recent : yearOld.length === 1 ? yearOld : [];
  if (!same.length) return { kind: yearOld.length > 1 ? "ambiguous" : "none", ...(yearOld.length > 1 ? { candidates: yearOld } : {}) } as { kind: "none" } | { kind: "ambiguous"; candidates: GContact[] };
  const paid = same.find(isPaid);
  if (paid) return { kind: "ok", contact: paid, byName: true };
  if (same.length > 1) return { kind: "ambiguous", candidates: same };
  return { kind: "tag", contact: same[0], byName: true };
}

/* Close a paid-deposit box once the work is visibly done (owner 11/05/2026:
   "it's supposed to disappear right after the client got the confirmation").
   Done = a LIVE read of her contact shows a paid tag AND a confirmed
   appointment. A failed read, or a lead we still can't name, leaves it open. */
export async function resolvePaidAlerts(svc: Svc): Promise<number> {
  const { data: open } = await svc.from("alerts").select("id, source_key, meta")
    .eq("type", "paid_not_synced").eq("status", "open").order("created_at", { ascending: true }).limit(25);
  let resolved = 0;
  for (const a of (open ?? []) as Array<{ id: string; source_key: string; meta: { location_id?: string; contact_id?: string } | null }>) {
    try {
      let loc = String(a.meta?.location_id ?? ""), cid = String(a.meta?.contact_id ?? "");
      if (!cid) {
        // "can't be found" boxes: a later run (or a person) may have matched her since.
        const key = a.source_key.replace(/^paid-(notfound|healed):/, "");
        const { data: chk } = await svc.from("paid_tag_checks").select("location_id, contact_id").eq("key", key).maybeSingle();
        const c = chk as { location_id: string | null; contact_id: string | null } | null;
        cid = String(c?.contact_id ?? ""); loc = loc || String(c?.location_id ?? "");
      }
      if (!loc || !cid) continue;
      const tok = await getAppLocationToken(loc);
      if (!tok.token) continue;
      const H = { Authorization: `Bearer ${tok.token}`, Version: "2021-07-28", Accept: "application/json" };
      const cr = await fetch(`${GHL}/contacts/${encodeURIComponent(cid)}`, { headers: H });
      if (!cr.ok) continue;
      const contact = ((await cr.json()) as { contact?: GContact }).contact;
      if (!contact || !isPaid(contact)) continue;
      const ar = await fetch(`${GHL}/contacts/${encodeURIComponent(cid)}/appointments`, { headers: H });
      if (!ar.ok) continue;
      const events = ((await ar.json()) as { events?: Array<Record<string, unknown>> }).events ?? [];
      const confirmed = events.some((e) => e.deleted !== true
        && ["confirmed", "showed"].includes(String(e.appointmentStatus ?? e.appoinmentStatus ?? "").toLowerCase()));
      if (!confirmed) continue;
      const { error } = await svc.from("alerts")
        .update({ status: "resolved", resolved_by: "system (paid tag on, appointment confirmed)", resolved_at: new Date().toISOString() })
        .eq("id", a.id).eq("status", "open");
      if (!error) resolved++;
    } catch { /* one bad read never stops the rest */ }
  }
  return resolved;
}

/* Paid but never booked (owner, 11/07/2026): the one-box creates the GHL
   appointment from the BROWSER, the moment the checkout reports the deposit
   cleared (OB_ONPAID). When that callback never runs — tab closed, wallet
   redirect, checkout script hiccup — the payment still reaches GHL through
   the Fanbasis webhook (tag "fanbasis buyer"), but no appointment exists, so
   the artist gets no notification and the lead no confirmation or reminders
   (first seen on a Shape-and-Shade lead who picked 11/16 10 AM). Server-side
   fallback: a paid contact whose one-box lead holds a picked time with no
   appointment gets booked through the same /api/onebox/book call the browser
   makes, so every automation fires exactly as it should have.

   11/17/2026 (Alicia Bailey, BeautyPros: paid at 11:13 PM, no appointment for
   10 hours). This fallback had never booked anyone, for three reasons, all
   closed here:
   1. It called the booking step on the cron's own host, which Vercel keeps
      behind a sign-in wall (see lib/self-origin) — the caller now passes the
      public address.
   2. It tried once per payment and kept a failure only in the cron's HTTP
      answer. Now every run looks again while her lead is still unbooked, and
      a failed try marks the lead "paid-not-booked" — which hands it to the
      30-minute retry (ghl-retry healPaidLeads, a direct GHL booking that
      needs no call to ourselves) — and files a "Paid but not booked" card.
   3. It never looked at her calendar first. /api/onebox/book treats the time
      it is given as the lead's latest wish and cancels other fresh
      appointments, which is right from her browser and wrong hours later:
      lookBeforePaidBooking leaves a time the artist set alone and sends
      anything unclear to a person.

   Division of work, so the two nets never book the same lead at once: this
   one owns leads the system has not yet marked paid; the 30-minute retry
   owns the paid statuses. */
type UnbookedLead = { id: number; slug: string; full_name: string | null; phone: string | null; answers: { email?: string; tz?: string } | null; slot_iso: string; ghl_status: string | null; picked_time_at: string | null; created_at: string };
type BookTry =
  | { kind: "none" }
  | { kind: "booked"; slot: string; slug: string }
  | { kind: "left"; lead: UnbookedLead; note: string }
  | { kind: "person"; lead: UnbookedLead; note: string }
  | { kind: "failed"; lead: Pick<UnbookedLead, "slug" | "slot_iso"> | null; error: string };
// Statuses the 30-minute retry owns (ghl-retry healPaidLeads), plus "booked".
const RETRY_OWNS = new Set(["booked", "paid", "paid-not-booked", "paid-followup"]);

async function postBook(origin: string, body: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const r = await fetch(`${origin}/api/onebox/book`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, via: "heal" }), // "heal": the booking step skips its browser-only Purchase
      redirect: "manual", signal: AbortSignal.timeout(30_000),
    });
    const j = (await r.json().catch(() => null)) as { ok?: boolean; error?: unknown; message?: unknown } | null;
    if (j?.ok === true) return { ok: true };
    // Our route answers { ok:false, error:"…" }; Vercel's wall answers { error: { message }, message }.
    const why = typeof j?.error === "string" ? j.error : typeof j?.message === "string" ? j.message : "";
    return { ok: false, error: `the booking step answered HTTP ${r.status}${why ? ` (${why.slice(0, 120)})` : ""}` };
  } catch (e) {
    return { ok: false, error: `the booking step could not be reached (${e instanceof Error ? e.message.slice(0, 100) : "fetch failed"})` };
  }
}

// At most this many live looks + booking calls per run; the rest wait 10 minutes.
const MAX_TRIES_PER_RUN = 5;

async function bookPaidNotBooked(svc: Svc, origin: string | undefined, a: { loc: string; contactId: string; token?: string; contact?: GContact; paidAtMs?: number; budget: { left: number } }): Promise<BookTry> {
  if (!origin) return { kind: "none" };
  /* Her NEWEST pick, booked or not. Taking the newest UNBOOKED row picked a
     stale one whenever a later pick was already booked: Alma Martínez
     (Brows by Susan, 11/16) had an old pick for 12/11 next to a paid, booked
     12/19 — a working net would have added 12/11 on top. */
  const { data: lead } = await svc.from("onebox_leads")
    .select("id, slug, full_name, phone, answers, slot_iso, ghl_status, ghl_appointment_id, picked_time_at, created_at")
    .eq("ghl_contact_id", a.contactId).not("slot_iso", "is", null)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  const newest = lead as (UnbookedLead & { ghl_appointment_id: string | null }) | null;
  if (newest?.ghl_appointment_id) return { kind: "none" }; // her latest pick is booked (or was settled by hand)
  const l = newest;
  if (!l) {
    if (!a.contact || a.budget.left <= 0) return { kind: "none" };
    const token = a.token ?? (await getAppLocationToken(a.loc)).token;
    if (!token) return { kind: "none" };
    a.budget.left--;
    return restoreRemovedHold(svc, origin, { loc: a.loc, token, contact: a.contact });
  }
  if (RETRY_OWNS.has(String(l.ghl_status ?? "")) || !l.full_name || !l.phone) return { kind: "none" };
  if (Date.parse(l.slot_iso) < Date.now()) return { kind: "none" }; // her time already passed; nothing sensible to book
  /* The payment must be FOR this pick: a time picked after she paid was
     never paid for (she may have paid for an appointment that has since
     taken place, then browsed the funnel again). */
  const pickedMs = Date.parse(String(l.picked_time_at ?? l.created_at));
  if (a.paidAtMs && Number.isFinite(pickedMs) && pickedMs > a.paidAtMs + 10 * 60_000) return { kind: "none" };
  if (a.budget.left <= 0) return { kind: "none" }; // next run
  a.budget.left--;
  const token = a.token ?? (await getAppLocationToken(a.loc)).token;
  if (!token) return { kind: "failed", lead: l, error: "no GHL token for this account" };
  const look = await lookBeforePaidBooking({ locationId: a.loc, token, contactId: a.contactId, slotIso: l.slot_iso, pickedAt: l.picked_time_at ?? l.created_at });
  if (!look.ok) return { kind: "failed", lead: l, error: `her calendar could not be read (${look.error})` };
  if (look.state === "other_time") return { kind: "left", lead: l, note: look.note };
  if (look.state === "needs_person") return { kind: "person", lead: l, note: look.note };
  // "none", or an appointment already at her time (the booking step reuses and confirms it).
  const r = await postBook(origin, { slug: l.slug, full_name: l.full_name, phone: l.phone, email: l.answers?.email ?? "", startTime: l.slot_iso, ...(l.answers?.tz ? { tz: l.answers.tz } : {}) });
  return r.ok ? { kind: "booked", slot: l.slot_iso, slug: l.slug } : { kind: "failed", lead: l, error: r.error };
}

/* She agreed a time with the AI, the AI-hold cleanup removed that unpaid
   hold (tag REMOVED_TAG), and she then paid somewhere that never called
   /book. Before the cleanup the account's "Invalid -> Confirm" workflow
   would have confirmed the hold; now the same time is booked fresh. */
async function restoreRemovedHold(svc: Svc, origin: string, r: { loc: string; token: string; contact: GContact }): Promise<BookTry> {
  if (!(r.contact.tags ?? []).some((t) => t.toLowerCase() === REMOVED_TAG) || !r.contact.phone) return { kind: "none" };
  const { data } = await svc.from("onebox_clients").select("slug, config").eq("location_id", r.loc).neq("status", "draft");
  const oc = ((data ?? []) as Array<{ slug: string; config: { calendarId?: string } | null }>).find((x) => x.config?.calendarId);
  if (!oc) return { kind: "none" };
  const start = await removedHoldTime(r.token, r.contact.id, oc.config!.calendarId!, r.loc);
  if (!start) return { kind: "none" };
  const name = (r.contact.contactName ?? `${r.contact.firstName ?? ""} ${r.contact.lastName ?? ""}`).trim() || "Client";
  const res = await postBook(origin, { slug: oc.slug, full_name: name, phone: r.contact.phone, email: "", startTime: start });
  return res.ok ? { kind: "booked", slot: start, slug: oc.slug } : { kind: "failed", lead: { slug: oc.slug, slot_iso: start }, error: `${res.error} (removed hold)` };
}

export async function healPaidTags(svc: Svc, origin?: string): Promise<{ checked: number; healed: string[]; notFound: string[]; booked: string[]; left: string[]; needsPerson: string[]; errors: string[] }> {
  const healed: string[] = [], notFound: string[] = [], booked: string[] = [], left: string[] = [], needsPerson: string[] = [], errors: string[] = [];
  const since = new Date(Date.now() - 48 * 3600_000).toISOString();
  const { data: rows } = await svc.from("deposits").select("data, synced_at").gte("synced_at", since);
  const recentDay = Date.now() - 3 * 86_400_000;
  const deps = ((rows ?? []) as Array<{ data: Record<string, unknown>; synced_at: string }>).filter((r) =>
    depositDay(r.data["Date"]) >= recentDay - 86_400_000 // only real new payments, not bulk re-syncs of old rows
    && Date.now() - Date.parse(r.synced_at) >= GRACE_MS
    && !/demo/i.test(String(r.data["Business Name"] ?? ""))
    && !/^router\.test/i.test(String(r.data["Email"] ?? "")) // the setup run's own test payment
    && String(r.data["Email"] ?? "").includes("@"));
  if (!deps.length) return { checked: 0, healed, notFound, booked, left, needsPerson, errors };

  const { data: ob } = await svc.from("onebox_clients").select("location_id, client_name");
  const locByBiz = new Map(((ob ?? []) as Array<{ location_id: string; client_name: string }>).map((o) => [normBiz(o.client_name), o.location_id]));
  const { data: cm } = await svc.from("clients_master").select("data");
  const ownerByBiz = new Map(((cm ?? []) as Array<{ data: Record<string, unknown> }>).map((r) => [normBiz(r.data["Business Name"]), String(r.data["Owner Full Name"] ?? "")]));

  /* Paid (already, or healed below) but the browser never created her
     appointment → book it now, server-side, and act on what came back. Never
     throws: one lead's trouble must not stop the rest of the run. */
  // Every unbooked row of hers on this funnel (she may have gone through it twice).
  const herRows = (contactId: string, slug: string, patch: Record<string, unknown>) =>
    svc.from("onebox_leads").update(patch).eq("ghl_contact_id", contactId).eq("slug", slug).is("ghl_appointment_id", null).not("slot_iso", "is", null);
  const budget = { left: MAX_TRIES_PER_RUN };
  const bookNow = async (p: { key: string; name: string; biz: string; row: Record<string, unknown>; paidAt: string; loc: string; contactId: string; token?: string; contact?: GContact }) => {
    const who = `${p.name} (${p.biz})`;
    try {
      const paidAtMs = Date.parse(p.paidAt);
      const t = await bookPaidNotBooked(svc, origin, { loc: p.loc, contactId: p.contactId, token: p.token, contact: p.contact, paidAtMs: Number.isFinite(paidAtMs) ? paidAtMs : undefined, budget });
      if (t.kind === "none") return;
      if (t.kind === "booked") {
        booked.push(who);
        await resolvePaidNotBookedAlert(svc, t.slug, p.contactId, p.name).catch(() => {});
        await fileOrAppendAlert(svc, {
          type: "paid_not_synced", severity: "medium",
          title: `${p.name} paid ${p.biz} but her appointment was never created — booked automatically`,
          detail: `Payment ${p.row["Amount"] ?? ""} on ${usDate(p.row["Date"])} cleared, but the booking call from her browser never ran, so GHL had no appointment (no artist notification, no confirmation or reminders). The time she picked (${/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(t.slot) ? `${new Date(t.slot).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" })} UTC` : `${t.slot.slice(0, 16).replace("T", " ")} studio time, the AI's removed hold`}) is now booked and confirmed, so every automation fires. Resolve this once checked.`,
          source_key: `paid-booked:${p.key}`, meta: { location_id: p.loc, contact_id: p.contactId, link: ghlContactUrl(p.loc, p.contactId) },
        });
        return;
      }
      if (t.kind === "left") {
        // The artist or the AI already put her on the calendar at another time: hers to keep.
        left.push(`${who}: ${t.note}`);
        await herRows(p.contactId, t.lead.slug, { ghl_appointment_id: "manual" });
        return;
      }
      if (t.kind === "person") {
        needsPerson.push(`${who}: ${t.note}`);
        await filePaidNotBookedAlert(svc, { slug: t.lead.slug, locationId: p.loc, contactId: p.contactId, name: p.name, slotIso: t.lead.slot_iso, business: p.biz, error: t.note, what: "She was NOT booked automatically", retrying: false }).catch(() => {});
        await herRows(p.contactId, t.lead.slug, { ghl_appointment_id: "manual" });
        return;
      }
      errors.push(`${p.biz}: ${t.error.slice(0, 160)}`);
      console.error("[paid-tag-heal] booking a paid lead failed:", who, t.error);
      if (t.lead) {
        await filePaidNotBookedAlert(svc, { slug: t.lead.slug, locationId: p.loc, contactId: p.contactId, name: p.name, slotIso: t.lead.slot_iso, business: p.biz, error: t.error, what: "The automatic booking failed" }).catch(() => {});
        // Hand her to the 30-minute retry, which books straight in GHL.
        await herRows(p.contactId, t.lead.slug, { ghl_status: "paid-not-booked" });
      }
    } catch (e) {
      errors.push(`${p.biz}: ${e instanceof Error ? e.message.slice(0, 100) : "book error"}`);
      console.error("[paid-tag-heal] booking a paid lead threw:", who, e instanceof Error ? e.message : e);
    }
  };

  let checked = 0;
  for (const r of deps) {
    const email = String(r.data["Email"]).trim().toLowerCase();
    const biz = String(r.data["Business Name"] ?? "").trim();
    const name = String(r.data["Full Name"] ?? email);
    const key = `${email}|${normBiz(biz)}|${r.data["Date"]}`;
    const { data: prev } = await svc.from("paid_tag_checks").select("result, attempts, location_id, contact_id").eq("key", key).maybeSingle();
    const p = prev as { result: string; attempts: number; location_id: string | null; contact_id: string | null } | null;
    if (p && p.result !== "not_found") {
      /* The tag is settled, her booking may not be: look again on every run
         (one small read; GHL is only called when a picked time is still
         unbooked). Until 11/17/2026 a payment was looked at exactly once. */
      if ((p.result === "ok" || p.result === "healed") && p.location_id && p.contact_id) {
        await bookNow({ key, name, biz, row: r.data, paidAt: r.synced_at, loc: p.location_id, contactId: p.contact_id });
      }
      continue;
    }
    checked++;
    try {
      let loc = locByBiz.get(normBiz(biz)) ?? null;
      if (!loc && ownerByBiz.get(normBiz(biz))) loc = (await resolveClientLocation(svc, null, ownerByBiz.get(normBiz(biz))!).catch(() => null))?.locationId ?? null;
      if (!loc) { await svc.from("paid_tag_checks").upsert({ key, result: "no_location", checked_at: new Date().toISOString() }); continue; }
      const tok = await getAppLocationToken(loc);
      if (!tok.token) { errors.push(`${biz}: ${tok.error}`); continue; }
      const H = { Authorization: `Bearer ${tok.token}`, Version: "2021-07-28", Accept: "application/json", "Content-Type": "application/json" };
      const t = await findPaidTarget(H, loc, email, name);
      if (t.kind === "none" || t.kind === "ambiguous") {
        const giveUp = Date.now() - Date.parse(r.synced_at) > NOT_FOUND_GIVE_UP_MS;
        await svc.from("paid_tag_checks").upsert({ key, location_id: loc, result: giveUp ? "not_found_final" : "not_found", attempts: (p?.attempts ?? 0) + 1, checked_at: new Date().toISOString() });
        if (giveUp) {
          notFound.push(`${name} (${biz})`);
          await fileOrAppendAlert(svc, {
            type: "paid_not_synced", severity: "high",
            title: t.kind === "ambiguous" ? `${name} paid a deposit to ${biz}, but ${t.candidates.length} leads share that name` : `${name} paid a deposit to ${biz}, but her lead can't be found in GHL`,
            detail: `Payment ${r.data["Amount"] ?? ""} on ${usDate(r.data["Date"])} (${email}) matched no lead with a phone — not by email, not by name. Her appointment is NOT confirmed: find her by name/phone and add the "fanbasis buyer" tag.`,
            source_key: `paid-notfound:${key}`, meta: { location_id: loc, email },
          });
        }
        continue;
      }
      const c = t.contact;
      const book = () => bookNow({ key, name, biz, row: r.data, paidAt: r.synced_at, loc: loc!, contactId: c.id, token: tok.token!, contact: c });
      if (t.kind === "ok") {
        await svc.from("paid_tag_checks").upsert({ key, location_id: loc, contact_id: c.id, result: "ok", checked_at: new Date().toISOString() });
        await book();
        continue;
      }
      const tg = await fetch(`${GHL}/contacts/${c.id}/tags`, { method: "POST", headers: H, body: JSON.stringify({ tags: ["fanbasis buyer"] }) });
      if (!tg.ok) { errors.push(`${biz}: tag HTTP ${tg.status}`); continue; }
      await svc.from("paid_tag_checks").upsert({ key, location_id: loc, contact_id: c.id, result: "healed", checked_at: new Date().toISOString() });
      healed.push(`${name} (${biz})`);
      await fileOrAppendAlert(svc, {
        type: "paid_not_synced", severity: "medium",
        title: `${name} paid ${biz} but GHL missed it — fixed automatically`,
        detail: t.byName
          ? `Payment ${r.data["Amount"] ?? ""} on ${usDate(r.data["Date"])} was made with ${email}, which isn't on her lead, so GHL filed it on a blank new contact. Her real lead (found by name, with her phone) got the "fanbasis buyer" tag, so the paid-deposit workflow now confirms her appointment. Resolve this once checked.`
          : `Payment ${r.data["Amount"] ?? ""} on ${usDate(r.data["Date"])} reached the Deposits sheet but not her GHL contact. The "fanbasis buyer" tag was added, so the paid-deposit workflow now confirms her appointment. Resolve this once checked.`,
        source_key: `paid-healed:${key}`, meta: { location_id: loc, contact_id: c.id, link: ghlContactUrl(loc, c.id) },
      });
      await book();
    } catch (e) {
      errors.push(`${biz}: ${e instanceof Error ? e.message.slice(0, 100) : "error"}`);
    }
  }
  return { checked, healed, notFound, booked, left, needsPerson, errors };
}
