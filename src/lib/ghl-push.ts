import { getAppLocationToken } from "@/lib/ghl-app";
import { getSurveyFieldMap, fmtReservedTime } from "@/lib/onebox";

/* The one-box → GHL contact push (upsert + custom fields + tag + survey
   note), extracted from /api/onebox/submit so the ghl-retry cron can re-run
   it for leads whose push failed live (2026-09-20..22: 290+ leads landed in
   GHL as bare email-only contacts created by the Commas payment webhook —
   no phone, no tag, so no AI follow-up ever fired). The upsert dedupes by
   phone, the tag endpoint only ever adds, and the note is additive, so
   re-running for a lead that half-succeeded is safe. */

export interface GhlPushInput {
  locationId: string;
  fullName: string;
  phone: string;
  email: string;
  answers: Record<string, string>;
  isB2B: boolean;
  b2bFieldMap?: Record<string, string>;
  surveyTag: string;
  /** false = contact/fields/note only — used for retries where firing the
      survey workflows (the AI script) would be wrong (paid or stale leads). */
  withTag: boolean;
  /** partial leads carry no answers yet — skip fields + note. */
  partial: boolean;
  disqualified: boolean;
}

export interface GhlPushResult {
  contactId: string | null;
  error?: string;
}

export async function pushLeadToGhl(inp: GhlPushInput): Promise<GhlPushResult> {
  try {
    const tok = await getAppLocationToken(inp.locationId);
    if (!tok.token) throw new Error(tok.error ?? "no location token");
    const [firstName, ...rest] = inp.fullName.split(/\s+/);
    const fieldMap = inp.partial ? {} : inp.isB2B ? (inp.b2bFieldMap ?? {}) : await getSurveyFieldMap(inp.locationId, tok.token);
    const customFields = Object.entries(inp.answers)
      .filter(([k, v]) => v && fieldMap[k])
      .map(([k, v]) => ({ id: fieldMap[k], value: k === "services" ? v.split(/,\s*/) : v }));
    const upsert = (withEmail: boolean) =>
      fetch("https://services.leadconnectorhq.com/contacts/upsert", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tok.token}`,
          Version: "2021-07-28",
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          locationId: inp.locationId,
          firstName,
          lastName: rest.join(" "),
          name: inp.fullName,
          phone: inp.phone,
          ...(withEmail && inp.email ? { email: inp.email } : {}),
          source: "One-Box Funnel",
          ...(customFields.length ? { customFields } : {}),
        }),
      });
    let r = await upsert(true);
    /* 422 = GHL rejected the payload — in practice a lead-typed email that
       fails validation ("x@.yahoo.com", trailing dot). Losing the whole
       contact over a typo'd email cost 3 leads their follow-up
       (2026-09-22); drop the email and keep the lead, noting the typo. */
    let badEmail = "";
    if (r.status === 422 && inp.email) {
      badEmail = inp.email;
      r = await upsert(false);
    }
    const j = (await r.json().catch(() => ({}))) as { contact?: { id?: string; email?: string | null } };
    if (!r.ok) throw new Error(`contacts/upsert ${r.status}`);
    const contactId = j.contact?.id ?? null;

    /* The upsert matches on phone and quietly drops the email when another
       contact already owns it (sub-accounts refuse duplicate emails). Try
       once more explicitly; if GHL still refuses, say so in the note. */
    let emailNote = badEmail ? `⚠ The email the lead typed (${badEmail}) is invalid — GHL rejected it, contact saved without it.` : "";
    if (!badEmail && contactId && inp.email && !(j.contact?.email ?? "").trim()) {
      const put = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${tok.token}`, Version: "2021-07-28", "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email: inp.email }),
      }).catch(() => null);
      if (!put || !put.ok) emailNote = `⚠ Email ${inp.email} could not be saved on this contact — GHL says another contact already has it.`;
    }

    /* Tag through the ADD endpoint, never through the upsert body: upsert
       REPLACES the whole tag array (Browology "(v3)"/"ai off", Aug 19). */
    if (contactId && inp.withTag && !inp.disqualified) {
      await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tok.token}`, Version: "2021-07-28", "Content-Type": "application/json" },
        body: JSON.stringify({ tags: [inp.surveyTag] }),
      }).catch(() => {});
    }

    if (contactId && !inp.partial) {
      const a = inp.answers;
      const note = inp.isB2B
        ? [
            "One-Box application:",
            `Area: ${a.area}`,
            `Spots needed: ${a.spots}`,
            `Weekly capacity: ${a.weekly}`,
            `Ready to start: ${a.start}`,
            `Experience: ${a.exp}`,
            `Current revenue: ${a.rev}`,
            `Desired revenue: ${a.want}`,
            `What sets them apart: ${a.edge}`,
            ...(a.program ? [
              `Program: ${a.program}`,
              `Services: ${a.services}`,
              `Brow price: $${a.browprice}${a.browflex ? ` · open to under $400: ${a.browflex}` : ""}`,
              `Instagram: ${a.instagram || "—"}`,
              `Google reviews: ${a.reviews}`,
            ] : []),
            ...(emailNote ? [emailNote] : []),
          ].join("\n")
        : [
            "One-Box survey:",
            `Area: ${a.area}`,
            `Had PMU before: ${a.had_pmu}`,
            `Age group: ${a.age}`,
            `Commutable: ${a.commutable}`,
            `Seriousness: ${a.seriousness}`,
            `Aftercare kit: ${a.aftercare_kit}`,
            ...Object.entries(a)
              .filter(([k, v]) => v && !["area", "had_pmu", "age", "commutable", "seriousness", "aftercare_kit", "email", "disqualified", "deprow", "ghl_error"].includes(k))
              .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`),
            ...(emailNote ? [emailNote] : []),
          ].join("\n");
      await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/notes`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tok.token}`, Version: "2021-07-28", "Content-Type": "application/json" },
        body: JSON.stringify({ body: note }),
      }).catch(() => {});
    }
    return { contactId };
  } catch (e) {
    return { contactId: null, error: String(e).slice(0, 180) };
  }
}

/* Create the native GHL appointment a paid lead should already have —
   the same call /api/onebox/book makes (confirmed status, calendar's own
   duration + title, reserved-time custom field), so all appointment
   automations (confirmations, reminders) fire exactly as if the booking
   had worked live. Skips contacts that already have an upcoming
   appointment, so a manual booking by the team is never duplicated. */
export async function bookAppointmentForLead(inp: {
  locationId: string; calendarId: string; contactId: string; slotIso: string;
}): Promise<{ appointmentId?: string; alreadyBooked?: boolean; error?: string }> {
  try {
    const tok = await getAppLocationToken(inp.locationId);
    if (!tok.token) throw new Error(tok.error ?? "no location token");
    const H = { Authorization: `Bearer ${tok.token}`, "Content-Type": "application/json", Accept: "application/json" };

    const existing = await fetch(`https://services.leadconnectorhq.com/contacts/${inp.contactId}/appointments`, {
      headers: { ...H, Version: "2021-07-28" },
    }).then((r) => (r.ok ? r.json() : { events: [] })).catch(() => ({ events: [] })) as { events?: { startTime?: string; appointmentStatus?: string }[] };
    const hasUpcoming = (existing.events ?? []).some((e) => {
      const ms = Date.parse(String(e.startTime ?? ""));
      return Number.isFinite(ms) && ms > Date.now() && String(e.appointmentStatus ?? "") !== "cancelled";
    });
    if (hasUpcoming) return { alreadyBooked: true };

    let durationMin = 30;
    let title = "Appointment";
    const calR = await fetch(`https://services.leadconnectorhq.com/calendars/${inp.calendarId}`, {
      headers: { ...H, Version: "2021-04-15" },
    }).catch(() => null);
    if (calR?.ok) {
      const calJ = (await calR.json()) as { calendar?: { slotDuration?: number; name?: string } };
      if (calJ.calendar?.slotDuration) durationMin = calJ.calendar.slotDuration;
      if (calJ.calendar?.name) title = calJ.calendar.name;
    }
    const endTime = new Date(new Date(inp.slotIso).getTime() + durationMin * 60000).toISOString();
    const ar = await fetch("https://services.leadconnectorhq.com/calendars/events/appointments", {
      method: "POST",
      headers: { ...H, Version: "2021-04-15" },
      body: JSON.stringify({
        calendarId: inp.calendarId,
        locationId: inp.locationId,
        contactId: inp.contactId,
        startTime: inp.slotIso,
        endTime,
        title,
        appointmentStatus: "confirmed",
      }),
    });
    const aj = (await ar.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!ar.ok) throw new Error(aj.message ?? `appointment ${ar.status}`);

    try {
      const fieldMap = await getSurveyFieldMap(inp.locationId, tok.token);
      if (fieldMap.reserved_time) {
        await fetch(`https://services.leadconnectorhq.com/contacts/${inp.contactId}`, {
          method: "PUT",
          headers: { ...H, Version: "2021-07-28" },
          body: JSON.stringify({ customFields: [{ id: fieldMap.reserved_time, value: fmtReservedTime(inp.slotIso) }] }),
        });
      }
    } catch { /* best effort — the appointment itself is booked */ }
    return { appointmentId: aj.id };
  } catch (e) {
    return { error: String(e).slice(0, 180) };
  }
}
