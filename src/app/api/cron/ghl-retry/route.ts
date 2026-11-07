import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { bookAppointmentForLead, pushLeadToGhl, addContactTagVerified } from "@/lib/ghl-push";
import { getAppLocationToken } from "@/lib/ghl-app";
import { addOneboxBookedTag, ensureContactOwner } from "@/lib/artist-notify";
import { filePaidNotBookedAlert, resolvePaidNotBookedAlert } from "@/lib/alerts";

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
    const notifyHealOnly = await healMissedArtistNotifications(svc);
    const tagHealOnly = await healMissingSurveyTags(svc);
    return NextResponse.json({ retried: 0, paidHeal: paidHealOnly, notifyHeal: notifyHealOnly, tagHeal: tagHealOnly });
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
  const notifyHeal = await healMissedArtistNotifications(svc);
  const tagHeal = await healMissingSurveyTags(svc);
  return NextResponse.json({ retried: leads.length, ok, failed, tagged, errors, paidHeal, notifyHeal, tagHeal });
}

/* Phase 4 — leads whose contact was created but the "onebox-survey" tag
   never landed (owner, 11/07/2026: ~1 lead in 12, every day, fleet-wide —
   contact, fields and note all saved, tags empty, so the sub-account's
   outreach workflow never fired and the lead never got a text). The push now
   verifies the tag and marks the lead "created-untagged" when it still fails;
   this pass re-reads each recent lead's tags LIVE (the synced copy can lag),
   re-adds the tag with the verified call, and puts the lead back to
   "created". Same policy as the retry above: only leads younger than
   TAG_WINDOW_MS get the tag (a late tag there is just a slightly delayed
   normal flow); never a lead who already paid or was disqualified. */
async function healMissingSurveyTags(svc: ReturnType<typeof createServiceClient>) {
  const since = new Date(Date.now() - TAG_WINDOW_MS).toISOString();
  const until = new Date(Date.now() - 10 * 60_000).toISOString(); // give the live push its own retries first
  const { data: leads } = await svc
    .from("onebox_leads")
    .select("id, slug, location_id, full_name, ghl_contact_id, ghl_status, answers, created_at")
    .in("ghl_status", ["created", "created-untagged"])
    .not("ghl_contact_id", "is", null)
    .gte("created_at", since).lte("created_at", until)
    .order("created_at", { ascending: false })
    .limit(150);
  const { data: clients } = await svc.from("onebox_clients").select("slug, extras").in("slug", [...new Set((leads ?? []).map((l) => l.slug as string))]);
  const b2bTag = new Map((clients ?? []).map((c) => [c.slug as string, ((c.extras ?? {}) as { template?: string; b2b?: { tag?: string } })]));
  let checked = 0, retagged = 0, stillMissing = 0;
  const tokens = new Map<string, string | null>();
  const errors: string[] = [];
  for (const l of leads ?? []) {
    const a = (l.answers ?? {}) as Record<string, unknown>;
    if (a.disqualified === true || a.disqualified === "true" || /test/i.test(String(l.full_name ?? ""))) continue;
    const ex = b2bTag.get(l.slug as string);
    const tag = ex?.template === "b2b" ? (ex.b2b?.tag || "b2b-onebox-survey") : "onebox-survey";
    const locationId = l.location_id as string;
    if (!tokens.has(locationId)) tokens.set(locationId, (await getAppLocationToken(locationId)).token ?? null);
    const tok = tokens.get(locationId);
    if (!tok) continue;
    try {
      const r = await fetch(`https://services.leadconnectorhq.com/contacts/${l.ghl_contact_id}`, {
        headers: { Authorization: `Bearer ${tok}`, Version: "2021-07-28", Accept: "application/json" },
      });
      if (!r.ok) continue;
      checked++;
      const tags = (((await r.json()) as { contact?: { tags?: string[] } }).contact?.tags ?? []).map((t) => t.toLowerCase());
      if (tags.includes(tag)) {
        if (l.ghl_status === "created-untagged") await svc.from("onebox_leads").update({ ghl_status: "created" }).eq("id", l.id);
        continue;
      }
      // A paid/booked contact must not have the outreach restarted.
      if (tags.some((t) => ["fanbasis buyer", "deposit collected", "booked"].includes(t))) continue;
      const ok = await addContactTagVerified(l.ghl_contact_id as string, tag, tok);
      if (ok) {
        retagged++;
        await svc.from("onebox_leads").update({ ghl_status: "created", answers: { ...a, tag_healed_at: new Date().toISOString() } }).eq("id", l.id);
      } else {
        stillMissing++;
        await svc.from("onebox_leads").update({ ghl_status: "created-untagged" }).eq("id", l.id);
      }
    } catch (e) {
      errors.push(`${l.slug}: ${e instanceof Error ? e.message.slice(0, 80) : "error"}`);
    }
  }
  if (retagged || stillMissing) console.log("[ghl-retry] survey-tag heal", { checked, retagged, stillMissing });
  return { checked, retagged, stillMissing, errors: errors.slice(0, 10) };
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
  const { data: paidLeads } = await svc
    .from("onebox_leads")
    .select("id, slug, location_id, full_name, phone, ghl_status, ghl_contact_id, ghl_appointment_id, slot_iso, answers, created_at")
    .in("ghl_status", [...PAID])
    .gte("created_at", new Date(Date.now() - 7 * 86400_000).toISOString())
    .order("created_at")
    .limit(60);
  const broken = (paidLeads ?? []).filter((l) => !l.ghl_contact_id || (!l.ghl_appointment_id && l.slot_iso));
  if (!broken.length) return { healed: 0 };

  const { data: clients } = await svc
    .from("onebox_clients")
    .select("slug, location_id, config, extras")
    .in("slug", [...new Set(broken.map((l) => l.slug))]);
  const bySlug = new Map((clients ?? []).map((c) => [c.slug as string, c]));

  let contactsFixed = 0, apptsCreated = 0, alreadyBooked = 0;
  const pastSlot: string[] = [];
  const errors: string[] = [];
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
      const ms = Date.parse(String(lead.slot_iso));
      if (!Number.isFinite(ms) || ms <= Date.now()) { pastSlot.push(`${lead.full_name} (${lead.slug}) ${lead.slot_iso}`); continue; }
      const calendarId = String(((client.config ?? {}) as Record<string, string>).calendarId ?? "").trim();
      if (!calendarId) { errors.push(`${lead.full_name}: no calendarId`); continue; }
      const booked = await bookAppointmentForLead({
        locationId: client.location_id as string, calendarId, contactId, slotIso: String(lead.slot_iso),
      });
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
      } else {
        errors.push(`${lead.full_name}: ${booked.error ?? "booking failed"}`);
        // Owner (2026-10-12): a paid lead still not booked must be on the Alerts tab.
        await filePaidNotBookedAlert(svc, {
          slug: lead.slug as string, locationId: client.location_id as string, contactId, name: lead.full_name as string,
          slotIso: String(lead.slot_iso), error: booked.error ?? "booking failed",
        }).catch(() => {});
      }
    }
  }
  return { healed: contactsFixed + apptsCreated, contactsFixed, apptsCreated, alreadyBooked, pastSlot, errors: errors.slice(0, 10) };
}
