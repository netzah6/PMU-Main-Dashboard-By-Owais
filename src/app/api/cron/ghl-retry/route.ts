import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { bookAppointmentForLead, pushLeadToGhl } from "@/lib/ghl-push";

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
  if (!leads?.length) return NextResponse.json({ retried: 0 });

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
      answers: a,
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
  return NextResponse.json({ retried: leads.length, ok, failed, tagged, errors, paidHeal });
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
      } else if (booked.alreadyBooked) {
        alreadyBooked++;
        await svc.from("onebox_leads").update({ ghl_appointment_id: "manual" }).eq("id", lead.id);
      } else {
        errors.push(`${lead.full_name}: ${booked.error ?? "booking failed"}`);
      }
    }
  }
  return { healed: contactsFixed + apptsCreated, contactsFixed, apptsCreated, alreadyBooked, pastSlot, errors: errors.slice(0, 10) };
}
