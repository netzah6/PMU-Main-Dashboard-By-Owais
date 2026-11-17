import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { bookAppointmentForLead, pushLeadToGhl } from "@/lib/ghl-push";
import { addOneboxBookedTag, ensureContactOwner } from "@/lib/artist-notify";
import { filePaidNotBookedAlert, paidCardOnBoard, resolvePaidNotBookedAlert } from "@/lib/alerts";
import { getAppLocationToken } from "@/lib/ghl-app";
import { everBookedSincePick } from "@/lib/paid-booking";

export const fetchCache = "force-no-store";
export const maxDuration = 300;

/* Re-push one-box leads whose GHL contact upsert failed at submit time
   (2026-09-20..22: ~290 leads existed only as bare email-only contacts the
   payment webhook created — no phone, no tag, so no AI follow-up fired).

   Tag policy: the onebox-survey tag fires the sub-account's AI outreach, so
   a retry only tags leads YOUNGER than 6 hours (a late tag there is just a
   slightly delayed version of the normal flow) and never leads that already
   paid. Older leads get contact + phone + fields + note only; firing the AI
   for a backlog is the owner's call (?tagAll=1 does it explicitly). */
const TAG_WINDOW_MS = 6 * 3600_000;
const PAID = new Set(["booked", "paid", "paid-not-booked", "paid-followup"]);

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const tagAll = req.nextUrl.searchParams.get("tagAll") === "1";

  const svc = createServiceClient();
  const { data: leads } = await svc
    .from("onebox_leads")
    .select("id, slug, location_id, full_name, phone, ghl_status, answers, created_at")
    .is("ghl_contact_id", null)
    .like("ghl_status", "failed%")
    .neq("phone", "")
    .gte("created_at", new Date(Date.now() - 7 * 86400_000).toISOString())
    .order("created_at", { ascending: false })
    .limit(40);
  /* No failed leads must NOT short-circuit phase 2 — that early return is
     exactly how the 2026-09-22 16:39 run skipped the paid-lead healing. */
  if (!leads?.length) {
    const paidHealOnly = await healPaidLeads(svc);
    await savePaidRetryStatus(svc, paidHealOnly);
    return NextResponse.json({ retried: 0, paidHeal: paidHealOnly });
  }

  const { data: clients } = await svc
    .from("onebox_clients")
    .select("slug, location_id, extras")
    .in("slug", [...new Set(leads.map((l) => l.slug))]);
  const bySlug = new Map((clients ?? []).map((c) => [c.slug as string, c]));

  let ok = 0, failed = 0, tagged = 0;
  const errors: Record<string, number> = {};
  for (const lead of leads) {
    const client = bySlug.get(lead.slug as string);
    if (!client) { failed++; continue; }
    const extras = (client.extras ?? {}) as { template?: string; b2b?: { tag?: string; fieldMap?: Record<string, string> } };
    const isB2B = extras.template === "b2b";
    const a = (lead.answers ?? {}) as Record<string, string>;
    const disqualified = a.disqualified === "true" || (a as Record<string, unknown>).disqualified === true;
    const fresh = Date.now() - new Date(lead.created_at as string).getTime() < TAG_WINDOW_MS;
    const paid = PAID.has(String(lead.ghl_status ?? ""));
    const withTag = !paid && (fresh || tagAll);

    const push = await pushLeadToGhl({
      locationId: client.location_id as string,
      fullName: String(lead.full_name ?? ""),
      phone: String(lead.phone ?? ""),
      email: String(a.email ?? ""),
      // short-survey arm never asked about commuting — same "Yes" the live push sends
      answers: !isB2B && !a.commutable && a.shortq2 === "b" ? { ...a, commutable: "Yes" } : a,
      isB2B, b2bFieldMap: extras.b2b?.fieldMap,
      surveyTag: isB2B ? (extras.b2b?.tag || "b2b-onebox-survey") : "onebox-survey",
      withTag, partial: false, disqualified,
    });
    if (push.contactId) {
      ok++;
      if (withTag) tagged++;
      await svc
        .from("onebox_leads")
        .update({ ghl_contact_id: push.contactId, ...(paid ? {} : { ghl_status: "created" }) })
        .eq("id", lead.id);
    } else {
      failed++;
      const key = (push.error ?? "unknown").slice(0, 80);
      errors[key] = (errors[key] ?? 0) + 1;
      await svc
        .from("onebox_leads")
        .update({ answers: { ...a, ghl_error: push.error ?? "unknown" } })
        .eq("id", lead.id);
    }
  }
  const paidHeal = await healPaidLeads(svc);
  await savePaidRetryStatus(svc, paidHeal);
  const notifyHeal = await healMissedArtistNotifications(svc);
  return NextResponse.json({ retried: leads.length, ok, failed, tagged, errors, paidHeal, notifyHeal });
}

/* Phase 3 — booked leads whose "onebox-booked" tag never landed, so the
   artist was never texted (G Kelly, Framed Brow Studio, 10/11/2026: booked
   fine, tag step failed silently inside the book route's best-effort
   block, nobody noticed). Only future appointments — tagging a past one
   would text the artist about a session that already happened. Every
   attempt is written to the lead so a failure is visible, not silent. */
async function healMissedArtistNotifications(svc: ReturnType<typeof createServiceClient>) {
  const { data: leads } = await svc
    .from("onebox_leads")
    .select("id, slug, location_id, full_name, ghl_contact_id, ghl_appointment_id, slot_iso, created_at")
    .is("artist_notified_at", null)
    .not("ghl_appointment_id", "is", null)
    .neq("ghl_appointment_id", "manual")
    .not("ghl_contact_id", "is", null)
    .gte("created_at", new Date(Date.now() - 30 * 86400_000).toISOString())
    .order("created_at")
    .limit(40);
  let due = (leads ?? []).filter((l) => { const ms = Date.parse(String(l.slot_iso ?? "")); return Number.isFinite(ms) && ms > Date.now(); });
  if (!due.length) return { tagged: 0 };
  // A lead can have duplicate rows (double submit); if ANY row for that
  // contact was already notified, don't text the artist a second time.
  const { data: already } = await svc.from("onebox_leads").select("ghl_contact_id")
    .in("ghl_contact_id", [...new Set(due.map((l) => l.ghl_contact_id as string))]).not("artist_notified_at", "is", null);
  const notified = new Set((already ?? []).map((r) => r.ghl_contact_id as string));
  for (const l of due.filter((l) => notified.has(l.ghl_contact_id as string))) {
    await svc.from("onebox_leads").update({ artist_notified_at: new Date().toISOString(), artist_notify_note: "duplicate row — artist already notified for this contact" }).eq("id", l.id);
  }
  due = due.filter((l) => !notified.has(l.ghl_contact_id as string));
  if (!due.length) return { tagged: 0 };
  const { data: clients } = await svc.from("onebox_clients").select("slug, location_id, extras").in("slug", [...new Set(due.map((l) => l.slug))]);
  const bySlug = new Map((clients ?? []).map((c) => [c.slug as string, c]));
  let taggedNow = 0;
  const errors: string[] = [];
  for (const lead of due) {
    const client = bySlug.get(lead.slug as string);
    if (!client || ((client.extras ?? {}) as { template?: string }).template === "b2b") continue;
    const locationId = client.location_id as string;
    const contactId = lead.ghl_contact_id as string;
    await ensureContactOwner(locationId, contactId);
    const tagged = await addOneboxBookedTag(locationId, contactId);
    if (tagged.ok) {
      taggedNow++;
      await svc.from("onebox_leads").update({ artist_notified_at: new Date().toISOString(), artist_notify_note: "onebox-booked tag added (late, by the heal cron) — GHL workflow notifies" }).eq("id", lead.id);
    } else {
      errors.push(`${lead.full_name}: ${tagged.note}`);
      await svc.from("onebox_leads").update({ artist_notify_note: `tag failed (heal): ${tagged.note}`.slice(0, 300) }).eq("id", lead.id);
    }
  }
  return { tagged: taggedNow, errors: errors.slice(0, 10) };
}

/* What the paid-lead retry did, readable from the database (app_settings
   "paid_retry_status"). Its HTTP answer only reaches Vercel's log. */
async function savePaidRetryStatus(svc: ReturnType<typeof createServiceClient>, result: Record<string, unknown>) {
  try {
    const now = new Date().toISOString();
    const { data: prevRow } = await svc.from("app_settings").select("value").eq("key", "paid_retry_status").maybeSingle();
    const prev = (prevRow?.value ?? {}) as Record<string, unknown>;
    const did = Number(result.apptsCreated ?? 0) + Number(result.alreadyBooked ?? 0) + Number(result.stale ?? 0) + ((result.needsPerson as unknown[] | undefined)?.length ?? 0) + ((result.errors as unknown[] | undefined)?.length ?? 0);
    await svc.from("app_settings").upsert({
      key: "paid_retry_status",
      value: { ...prev, at: now, last: result, ...(did ? { last_action: result, last_action_at: now } : {}) },
      updated_by: "cron ghl-retry", updated_at: now,
    });
  } catch (e) {
    console.error("[ghl-retry] could not save the paid-lead retry status:", e instanceof Error ? e.message : e);
  }
}

/* About when she paid, from every record we keep: the Deposits row with her
   e-mail (it lands about a minute after the payment), our first check of
   that payment for her contact (15-25 minutes after), and the stamp the
   booking step writes. The newest one counts. A Deposits row that was
   synced again later is capped by its own date. */
async function paymentMoment(svc: ReturnType<typeof createServiceClient>, a: { email: string; paidAt: string | null; contactId: string }): Promise<{ ms: number | null; error?: string }> {
  const email = a.email.trim();
  const [dep, chk] = await Promise.all([
    email
      ? svc.from("deposits").select("synced_at, data").ilike("data->>Email", email.replace(/[\\%_]/g, "\\$&")).order("synced_at", { ascending: false }).limit(3)
      : Promise.resolve({ data: [] as Array<{ synced_at: string; data: Record<string, unknown> }>, error: null }),
    svc.from("paid_tag_checks").select("checked_at").eq("contact_id", a.contactId).in("result", ["ok", "healed"]).order("checked_at", { ascending: false }).limit(1),
  ]);
  const readErr = dep.error ?? chk.error;
  if (readErr) return { ms: null, error: readErr.message.slice(0, 100) };
  const moments: number[] = [];
  for (const d of ((dep.data ?? []) as Array<{ synced_at: string; data: Record<string, unknown> }>)) {
    const m = String(d.data?.["Date"] ?? "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // sheet dates are DD/MM/YYYY
    const dayEnd = m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) + 48 * 3600_000 : Infinity;
    moments.push(Math.min(Date.parse(d.synced_at), dayEnd));
  }
  for (const c of ((chk.data ?? []) as Array<{ checked_at: string | null }>)) moments.push(Date.parse(String(c.checked_at ?? "")));
  moments.push(Date.parse(String(a.paidAt ?? "")));
  const known = moments.filter((x) => Number.isFinite(x) && x <= Date.now());
  return { ms: known.length ? Math.max(...known) : null };
}

/* Has she had (or does she have) any appointment since she paid? true / false,
   or null when her calendar could not be read. */
async function paidLeadWasServed(a: { locationId: string; contactId: string; slotIso: string; paidMs: number }): Promise<boolean | null> {
  const tok = await getAppLocationToken(a.locationId);
  if (!tok.token) return null;
  // "Since she paid": anything made from half a day before the payment on, or any kept appointment that takes place after it (the AI may have booked her days before she paid).
  const from = a.paidMs - 12 * 3600_000;
  const ever = await everBookedSincePick({ locationId: a.locationId, token: tok.token, contactId: a.contactId, slotIso: a.slotIso, pickedAt: new Date(from).toISOString(), servedAfterMs: from });
  return ever.ok ? ever.booked : null;
}

/* Phase 2 — PAID leads the outage (or an off-page payment) left broken:
   their status was flipped to paid-followup/paid-not-booked by payment
   reconciliation, so the failed% sweep above never sees them. A paying
   client must end up with (a) a complete contact — no tag, the AI must
   not restart its script on someone who already paid — and (b) a real
   GHL appointment for their picked slot, because the appointment is what
   fires the confirmation + reminder automations and puts them on the
   artist's calendar. Past slots are only reported (booking a time that
   already went by would fire nonsense confirmations) — the team handles
   those by hand. */
async function healPaidLeads(svc: ReturnType<typeof createServiceClient>) {
  /* Only the broken rows, newest first. Until 11/17/2026 this read the 60
     OLDEST paid leads of the week and looked for broken ones among them:
     with 128 paid leads in 7 days, anything newer than 4 days was never
     seen (Rosario Ramos sat "paid-not-booked" with an open card for 2 days
     although she had a confirmed appointment; Alma Martínez was never
     looked at). Newest first also means that when she went through the
     funnel twice, her latest pick is the one that gets booked. */
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
  const { data: paidLeads, error: readErr } = await svc
    .from("onebox_leads")
    .select("id, slug, location_id, full_name, phone, ghl_status, ghl_contact_id, ghl_appointment_id, slot_iso, picked_time_at, paid_at, answers, created_at")
    .in("ghl_status", [...PAID])
    /* A lead with no contact is re-pushed for a week (as before). A paid
       lead with an unbooked picked time has no date floor: she is retried
       for as long as that time is ahead, however old her row is (40 such
       rows exist all-time, 3 with a time still ahead). */
    .or(`and(ghl_contact_id.is.null,created_at.gte.${weekAgo}),and(ghl_appointment_id.is.null,slot_iso.not.is.null)`)
    .order("created_at", { ascending: false })
    .limit(300);
  // A failed read is an error in the saved status, never "nothing to heal".
  if (readErr) return { healed: 0, errors: [`paid leads could not be read: ${readErr.message.slice(0, 120)}`] };
  const nowMs = Date.now();
  const broken = (paidLeads ?? []).filter((l) => (!l.ghl_contact_id && Date.parse(String(l.created_at)) >= nowMs - 7 * 86400_000)
    // A time that passed long ago is not listed on every run forever: only recent picks are reported as "past".
    || (!l.ghl_appointment_id && l.slot_iso && (Date.parse(String(l.slot_iso)) > nowMs || Date.parse(String(l.picked_time_at ?? l.created_at)) >= nowMs - 21 * 86400_000)));
  if (!broken.length) return { healed: 0 };

  const { data: clients, error: clientsErr } = await svc
    .from("onebox_clients")
    .select("slug, location_id, config, extras")
    .in("slug", [...new Set(broken.map((l) => l.slug))]);
  if (clientsErr) return { healed: 0, errors: [`funnels could not be read: ${clientsErr.message.slice(0, 120)}`] };
  const bySlug = new Map((clients ?? []).map((c) => [c.slug as string, c]));

  let contactsFixed = 0, apptsCreated = 0, alreadyBooked = 0, stale = 0, notProven = 0;
  const pastSlot: string[] = [];
  const needsPerson: string[] = [];
  const errors: string[] = [];
  const settled = new Set<string>();
  for (const lead of broken) {
    const client = bySlug.get(lead.slug as string);
    if (!client) continue;
    const extras = (client.extras ?? {}) as { template?: string; b2b?: { fieldMap?: Record<string, string> } };
    const isB2B = extras.template === "b2b";
    const a = (lead.answers ?? {}) as Record<string, string>;

    let contactId = lead.ghl_contact_id as string | null;
    if (!contactId && lead.phone) {
      const push = await pushLeadToGhl({
        locationId: client.location_id as string,
        fullName: String(lead.full_name ?? ""), phone: String(lead.phone ?? ""), email: String(a.email ?? ""),
        answers: a, isB2B, b2bFieldMap: extras.b2b?.fieldMap,
        surveyTag: "onebox-survey", withTag: false, partial: false,
        disqualified: Boolean(a.disqualified),
      });
      if (push.contactId) {
        contactId = push.contactId;
        contactsFixed++;
        await svc.from("onebox_leads").update({ ghl_contact_id: contactId }).eq("id", lead.id);
      } else {
        errors.push(`${lead.full_name}: ${push.error ?? "push failed"}`);
        continue;
      }
    }

    if (contactId && !lead.ghl_appointment_id && lead.slot_iso && !isB2B) {
      /* Her other row was settled a moment ago in this same run (she went
         through the funnel twice). GHL can take a few seconds to list a new
         appointment, so a second look could miss it and book her again. */
      if (settled.has(contactId)) continue;
      const ms = Date.parse(String(lead.slot_iso));
      if (!Number.isFinite(ms) || ms <= Date.now()) { pastSlot.push(`${lead.full_name} (${lead.slug}) ${lead.slot_iso}`); continue; }
      /* Only her NEWEST paid journey is ever booked. An older row is a wish
         she has since replaced when a newer row of hers is booked or is
         itself marked paid (Alma Martínez, 11/16: an old pick for 12/11 next
         to a paid, booked 12/19): close it without touching GHL. A newer row
         that is only an unpaid pick does not count — picking again rewrites
         the time on all her rows, so this row already holds her latest wish. */
      const { data: newer } = await svc.from("onebox_leads").select("id")
        .eq("slug", lead.slug as string).eq("ghl_contact_id", contactId).not("slot_iso", "is", null)
        .gt("created_at", lead.created_at as string)
        .or(`ghl_appointment_id.not.is.null,ghl_status.in.(${[...PAID].join(",")})`).limit(1);
      if (newer?.length) {
        stale++;
        await svc.from("onebox_leads").update({ ghl_appointment_id: "manual" }).eq("id", lead.id);
        continue;
      }
      const calendarId = String(((client.config ?? {}) as Record<string, string>).calendarId ?? "").trim();
      if (!calendarId) { errors.push(`${lead.full_name}: no calendarId`); continue; }
      /* Proof of a payment for THIS pick comes before anything else. A paid
         status alone is not proof: picking a time again re-stamps the slot
         on every row of hers, also on a row that was paid weeks ago (56 such
         rows sit unbooked), and this job would then book a time nobody paid
         for. No payment in the last 4 days = not ours to touch. */
      const paid = await paymentMoment(svc, { email: String(a.email ?? ""), paidAt: lead.paid_at as string | null, contactId });
      if (paid.error) { errors.push(`${lead.full_name}: payment records could not be read (${paid.error})`); continue; } // an error, not "no payment"
      const paidMs = paid.ms;
      if (paidMs === null || Date.now() - paidMs > 4 * 86400_000) { notProven++; continue; }
      const pickedMs = Date.parse(String(lead.picked_time_at ?? lead.created_at));
      /* Of 270 payments made on the page, 267 came within 30 minutes of the
         pick and none after 24 hours. The payment moment can be our first
         check of it (about 20 minutes late), hence the half hour of slack. */
      const forThisPick = Number.isFinite(pickedMs) && pickedMs >= paidMs - 24.5 * 3600_000 && pickedMs <= paidMs + 30 * 60_000;
      const pickedAt = (lead.picked_time_at as string | null) ?? (lead.created_at as string);
      const res = await bookAppointmentForLead({
        locationId: client.location_id as string, calendarId, contactId, slotIso: String(lead.slot_iso), pickedAt, lookOnly: !forThisPick,
      });
      if (res.wait) continue; // the paid tag is not on her contact yet: the next run looks again
      let booked: typeof res = res;
      if (!forThisPick && !res.alreadyBooked) { // "already booked" needs no proof: her rows are settled and an open card closed, below
        /* She paid lately, but this time was picked long before or after the
           payment. Something already on her calendar: leave everything as it
           is. Nothing on it, and nothing since she paid: she may be an unbooked
           payer (she opened her pay link again), so a person is told. */
        if (!res.wouldBook) { notProven++; continue; }
        const ever = await paidLeadWasServed({ locationId: client.location_id as string, contactId, slotIso: String(lead.slot_iso), paidMs });
        if (ever !== false) { notProven++; continue; } // she has had an appointment since she paid, or it could not be read
        booked = { needsPerson: "this time was picked long before or after she paid, and nothing has been on her calendar since she paid: check it is the time she paid for" };
      }
      if (booked.needsPerson) {
        /* Not a clean case (see lib/paid-booking): a person looks. The row is
           closed to retries only once the card is really on the board. */
        await filePaidNotBookedAlert(svc, {
          slug: lead.slug as string, locationId: client.location_id as string, contactId, name: lead.full_name as string,
          slotIso: String(lead.slot_iso), error: booked.needsPerson, what: "She was NOT booked automatically", retrying: false, otherTime: booked.otherTime,
        }).catch(() => {});
        const onBoard = await paidCardOnBoard(svc, lead.slug as string, contactId, lead.full_name as string).catch(() => false);
        needsPerson.push(`${lead.full_name} (${lead.slug})${onBoard ? "" : " — card not filed, will try again"}`);
        if (!onBoard) continue;
      }
      if (booked.appointmentId || booked.alreadyBooked || booked.needsPerson) {
        settled.add(contactId);
        // Every unbooked row of hers on this funnel, not just this one.
        await svc.from("onebox_leads").update({ ghl_appointment_id: booked.appointmentId ?? "manual" })
          .eq("slug", lead.slug as string).eq("ghl_contact_id", contactId).is("ghl_appointment_id", null).neq("id", lead.id);
      }
      if (booked.appointmentId) {
        apptsCreated++;
        await svc.from("onebox_leads").update({ ghl_appointment_id: booked.appointmentId }).eq("id", lead.id);
        await resolvePaidNotBookedAlert(svc, lead.slug as string, contactId, lead.full_name as string).catch(() => {});
        /* A healed booking is as new to the artist as a live one — the
           "onebox-booked" tag fires the account's notification workflow
           (bookAppointmentForLead already wrote the reserved-time field
           the message reads). The notification targets the CONTACT OWNER,
           so guarantee one exists before the tag lands. */
        await ensureContactOwner(client.location_id as string, contactId);
        const tagged = await addOneboxBookedTag(client.location_id as string, contactId);
        if (tagged.ok) {
          await svc.from("onebox_leads")
            .update({ artist_notified_at: new Date().toISOString(), artist_notify_note: "onebox-booked tag added (heal) — GHL workflow notifies" })
            .eq("id", lead.id);
        } else {
          errors.push(`${lead.full_name}: onebox-booked tag — ${tagged.note}`);
        }
      } else if (booked.alreadyBooked) {
        alreadyBooked++;
        await svc.from("onebox_leads").update({ ghl_appointment_id: "manual" }).eq("id", lead.id);
        await resolvePaidNotBookedAlert(svc, lead.slug as string, contactId, lead.full_name as string).catch(() => {});
      } else if (booked.needsPerson) {
        await svc.from("onebox_leads").update({ ghl_appointment_id: "manual" }).eq("id", lead.id);
      } else {
        errors.push(`${lead.full_name}: ${booked.error ?? "booking failed"}`);
        // Owner (2026-10-12): a paid lead still not booked must be on the Alerts tab.
        await filePaidNotBookedAlert(svc, {
          slug: lead.slug as string, locationId: client.location_id as string, contactId, name: lead.full_name as string,
          slotIso: String(lead.slot_iso), error: booked.error ?? "booking failed", what: "The automatic booking failed",
        }).catch(() => {});
      }
    }
  }
  return { healed: contactsFixed + apptsCreated, contactsFixed, apptsCreated, alreadyBooked, stale, notProven, needsPerson, pastSlot: pastSlot.slice(0, 20), errors: errors.slice(0, 10) };
}
