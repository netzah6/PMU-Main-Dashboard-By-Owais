import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken } from "@/lib/ghl-app";
import { sendCapiEvent, capiToken } from "@/lib/meta-capi";
import { getSurveyFieldMap, fmtReservedTime, liveAppointmentsOnCalendar, wallToIso } from "@/lib/onebox";
import { ensureContactOwner } from "@/lib/artist-notify";
import { cleanTz } from "@/lib/ghl-push";

// Never serve cached fetches: Supabase rows and GHL availability must be live.
export const fetchCache = "force-no-store";

// Books the appointment server-side with the survey's own data — the
// lead never re-enters name/phone/email. Upserts the contact (idempotent
// with the survey submit) and creates a native GHL appointment, so all
// appointment automations fire exactly as with the widget.
export async function POST(req: NextRequest) {
  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }

  const slug = String(body.slug ?? "").slice(0, 100);
  const fullName = String(body.full_name ?? "").trim().slice(0, 200);
  const phone = String(body.phone ?? "").trim().slice(0, 40);
  const email = String(body.email ?? "").trim().slice(0, 200);
  const startTime = String(body.startTime ?? "");
  if (!slug || !fullName || !phone || !/^\d{4}-\d{2}-\d{2}T/.test(startTime)) {
    return NextResponse.json({ ok: false, error: "missing fields" }, { status: 400 });
  }

  const svc = createServiceClient();
  const { data: client } = await svc
    .from("onebox_clients")
    .select("slug, location_id, status, config, extras")
    .eq("slug", slug)
    .single();
  const cfg = (client?.config ?? {}) as Record<string, string>;
  /* B2B funnel: config lives in extras.b2b (the CV sync owns `config`),
     its own tag, no deposit — a booked call IS the conversion. */
  const extrasAll = (client?.extras ?? {}) as { template?: string; b2b?: { tag?: string; calendarId?: string } };
  const isB2B = extrasAll.template === "b2b";
  const calendarId = isB2B ? (extrasAll.b2b?.calendarId ?? "") : cfg.calendarId;
  if (!client || client.status === "draft" || !calendarId) {
    return NextResponse.json({ ok: false, error: "unknown funnel" }, { status: 404 });
  }
  const locationId = client.location_id as string;
  const surveyTag = isB2B ? (extrasAll.b2b?.tag || "b2b-onebox-survey") : "onebox-survey";

  const tok = await getAppLocationToken(locationId);
  if (!tok.token) return NextResponse.json({ ok: false, error: "no token" }, { status: 502 });
  const H = {
    Authorization: `Bearer ${tok.token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // Contact (idempotent with the survey submit's upsert).
  const [firstName, ...rest] = fullName.split(/\s+/);
  /* Post-payment path: every sequential round trip here widens the window
     in which a crash leaves a PAYING client without an appointment. The
     upsert, the lead lookup and the calendar meta are independent — run
     them together. */
  const [cr, leadPreRes, calR] = await Promise.all([
    fetch("https://services.leadconnectorhq.com/contacts/upsert", {
      method: "POST",
      headers: { ...H, Version: "2021-07-28" },
      body: JSON.stringify({
        locationId,
        firstName,
        lastName: rest.join(" "),
        name: fullName,
        phone,
        ...(email ? { email } : {}),
        source: "One-Box Funnel",
        ...(cleanTz(body.tz) ? { timezone: cleanTz(body.tz) } : {}),
      }),
    }),
    svc
      .from("onebox_leads")
      .select("answers")
      .eq("slug", slug)
      .eq("phone", phone)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    fetch(
      `https://services.leadconnectorhq.com/calendars/${encodeURIComponent(calendarId)}`,
      { headers: { ...H, Version: "2021-04-15" } }
    ),
  ]);
  const cj = (await cr.json()) as { contact?: { id?: string } };
  const contactId = cj.contact?.id;
  if (!cr.ok || !contactId) {
    return NextResponse.json({ ok: false, error: "contact upsert failed" }, { status: 502 });
  }

  /* Additive tag endpoint only — tags in the upsert body REPLACE the
     contact's whole tag list and were wiping workflow-added tags. A lead
     marked disqualified at submit stays untagged here too. */
  const disqualified = !isB2B && Boolean((leadPreRes.data?.answers as { disqualified?: boolean } | null)?.disqualified);
  if (!disqualified) {
    await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
      method: "POST",
      headers: { ...H, Version: "2021-07-28" },
      body: JSON.stringify({ tags: [surveyTag] }),
    }).catch(() => {});
  }

  // Calendar meta for duration + title.
  let durationMin = 30;
  let title = "Appointment";
  if (calR.ok) {
    const calJ = (await calR.json()) as { calendar?: { slotDuration?: number; name?: string } };
    if (calJ.calendar?.slotDuration) durationMin = calJ.calendar.slotDuration;
    if (calJ.calendar?.name) title = calJ.calendar.name;
  }
  /* She may already be on this calendar — the AI books leads here in chat,
     and a second, deposit-made appointment meant two or three confirmations
     and reminders for one session (Alma Tejeda / Mood Studios: Oct 3 + Oct 5
     + Nov 5, 2026-09-30; 19 more contacts across 13 accounts). Reuse only
     what is clearly this booking: an appointment made during her own funnel
     journey that no earlier deposit paid for. Same time → keep it; exactly
     one other → move it to the time she paid for; anything unclear → book a
     new one as before. Leftovers get a tag so the team can clean up. */
  const [{ tz, appts }, { data: mine }] = await Promise.all([
    liveAppointmentsOnCalendar(contactId, calendarId, locationId, tok.token),
    svc.from("onebox_leads").select("ghl_appointment_id, created_at").eq("slug", slug).eq("phone", phone),
  ]);
  // A slot with no offset (the reserved-time path) is the studio's wall clock.
  const startIso = tz && !/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(startTime) ? wallToIso(startTime, tz) : startTime;
  const endTime = new Date(Date.parse(startIso) + durationMin * 60000).toISOString();
  const mineRows = (mine ?? []) as { ghl_appointment_id: string | null; created_at: string }[];
  const paidIds = new Set(mineRows.map((r) => r.ghl_appointment_id).filter(Boolean));
  const journeyStart = mineRows.length
    ? Math.min(...mineRows.map((r) => Date.parse(r.created_at)))
    : Date.now() - 30 * 86400_000; // pay-link lead with no funnel row
  const candidates = appts.filter((a) => !paidIds.has(a.id) && (a.addedMs || 0) >= journeyStart - 86400_000);
  const same = candidates.find((a) => Math.abs(a.startMs - Date.parse(startIso)) < 60_000);
  const putAppointment = (id: string, patch: Record<string, string>) =>
    fetch(`https://services.leadconnectorhq.com/calendars/events/appointments/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { ...H, Version: "2021-04-15" },
      body: JSON.stringify(patch),
    }).then((r) => r.ok).catch(() => false);
  let reused: { id: string } | null = null;
  let needsReview = false;
  if (same) {
    // Already at the paid time — never book over it, even if confirming fails.
    reused = { id: same.id };
    if (same.status !== "confirmed" && !(await putAppointment(same.id, { appointmentStatus: "confirmed" }))) needsReview = true;
  } else if (candidates.length === 1
    && await putAppointment(candidates[0].id, { startTime: startIso, endTime, appointmentStatus: "confirmed" })) {
    reused = { id: candidates[0].id };
  }

  let aj: { id?: string; message?: string } = reused ?? {};
  const ar = reused ? null : await fetch("https://services.leadconnectorhq.com/calendars/events/appointments", {
    method: "POST",
    headers: { ...H, Version: "2021-04-15" },
    body: JSON.stringify({
      calendarId,
      locationId,
      contactId,
      startTime: startIso,
      endTime,
      title,
      appointmentStatus: "confirmed",
    }),
  });
  if (ar) aj = (await ar.json()) as { id?: string; message?: string };
  if (ar && !ar.ok) {
    console.error("[onebox/book] appointment failed:", ar.status, aj);
    /* This call happens after the deposit is paid, so a failure here
       means a paying client has no appointment — tag the contact so the
       team sees it and can call them, and record it on the lead. */
    await fetch("https://services.leadconnectorhq.com/contacts/" + contactId + "/tags", {
      method: "POST",
      headers: { ...H, Version: "2021-07-28" },
      body: JSON.stringify({ tags: ["onebox-booking-failed"] }),
    }).catch(() => {});
    await svc
      .from("onebox_leads")
      .update({ ghl_status: "paid-not-booked", ghl_contact_id: contactId })
      .eq("slug", slug)
      .eq("phone", phone)
      .then(() => {});
    return NextResponse.json(
      { ok: false, error: aj.message ?? `appointment ${ar.status}` },
      { status: 502 }
    );
  }

  /* The appointment exists — everything left is bookkeeping on
     independent systems (lead row, reserved-time field, Meta CAPI).
     Run the three together; each is individually best-effort. */
  const ex = (client.extras ?? {}) as { metaPixelId?: string; capiToken?: string; selfNotifies?: boolean };
  const pixelId = (cfg.metaPixelId || ex.metaPixelId || "").replace(/\D/g, "");
  const token = capiToken(ex);
  const eventId = String(body.eventId ?? "");
  const bookedId = aj.id ?? null;
  const leftover = needsReview || candidates.some((a) => a.id !== bookedId);
  if (leftover) console.warn("[onebox/book] other live appointments remain for", contactId, candidates.map((a) => a.id));
  await Promise.all([
    /* More than one live appointment for this session (an AI booking left
       over, or a confirm that failed): tag it so the team cancels the extra
       before it sends its own reminders. */
    (leftover
      ? fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
          method: "POST",
          headers: { ...H, Version: "2021-07-28" },
          body: JSON.stringify({ tags: ["onebox-check-appointments"] }),
        }).then(() => {}).catch(() => {})
      : Promise.resolve()),
    // Reflect the booking on the stored lead row.
    svc
      .from("onebox_leads")
      .update({ ghl_status: "booked", ghl_contact_id: contactId, ghl_appointment_id: bookedId })
      .eq("slug", slug)
      .eq("phone", phone)
      .then(() => {}),
    /* The template's workflows read the booked slot from the contact's
       "CC - Reserved Appointment Time" field — keep it filled here too.
       (B2C only: the agency's B2B workflows read the appointment itself.)
       THEN tag "onebox-booked": the "CC - One-Box Booking -> Notify
       Artist" workflow fires the artist's internal notification on that
       tag (owner design 2026-09-26 — 100% inside GHL, and manual GHL
       bookings never get the tag, so they never text the artist). The
       tag must land AFTER the reserved-time field, because the
       notification's time merge-field reads it. */
    (async () => {
      if (isB2B) return;
      try {
        const fieldMap = await getSurveyFieldMap(locationId, tok.token!);
        if (fieldMap.reserved_time) {
          await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
            method: "PUT",
            headers: { ...H, Version: "2021-07-28" },
            body: JSON.stringify({ customFields: [{ id: fieldMap.reserved_time, value: fmtReservedTime(startIso) }] }),
          });
        }
        /* The notification goes to the CONTACT OWNER — make sure there is
           one before the tag fires the workflow (ownerless contacts made
           10 of the 36 backfilled notifications vanish, 2026-09-26). */
        await ensureContactOwner(locationId, contactId);
        const tr = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
          method: "POST",
          headers: { ...H, Version: "2021-07-28" },
          body: JSON.stringify({ tags: ["onebox-booked"] }),
        });
        if (tr.ok) {
          await svc.from("onebox_leads")
            .update({ artist_notified_at: new Date().toISOString(), artist_notify_note: "onebox-booked tag added — GHL workflow notifies" })
            .eq("slug", slug).eq("phone", phone);
        }
      } catch { /* best effort — the appointment itself is already booked */ }
    })(),
    // Server-side Purchase — this endpoint only runs once the deposit has
    // cleared, so it is the honest signal for optimising on paying clients.
    // B2B books a free call (no purchase); the agency workflow's own
    // appointment-status CAPI covers Meta, same as the original funnel.
    (async () => {
      if (isB2B || !pixelId || !token || !eventId) return;
      const amount = parseFloat(String(cfg.deposit ?? "").replace(/[^0-9.]/g, ""));
      await sendCapiEvent({
        pixelId, token, eventName: "Purchase", eventId,
        eventSourceUrl: String(body.pageUrl ?? "") || undefined,
        value: Number.isFinite(amount) ? amount : undefined,
        currency: "USD",
        user: {
          email, phone, fullName,
          fbp: String(body.fbp ?? ""), fbc: String(body.fbc ?? ""),
          clientIp: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
          userAgent: req.headers.get("user-agent"),
        },
      }).catch(() => {});
    })(),
  ]);

  return NextResponse.json({ ok: true, appointmentId: aj.id ?? null });
}
