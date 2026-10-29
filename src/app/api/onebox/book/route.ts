import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken } from "@/lib/ghl-app";
import { sendCapiEvent, capiToken, recordCapi } from "@/lib/meta-capi";
import { getSurveyFieldMap, fmtReservedTime, liveAppointmentsOnCalendar, wallToIso, AI_HOLD_STATUS, AI_HOLD_LIVE_MS, type ContactAppointment } from "@/lib/onebox";
import { ensureContactOwner } from "@/lib/artist-notify";
import { cleanTz, calendarDurationMin } from "@/lib/ghl-push";
import { fileDoubleBookingAlert, filePaidNotBookedAlert } from "@/lib/alerts";

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
      .select("id, answers")
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
    const calJ = (await calR.json()) as { calendar?: { slotDuration?: number; slotDurationUnit?: string; durationOptions?: Array<{ duration?: number; durationUnit?: string; isDefault?: boolean }>; name?: string } };
    durationMin = calendarDurationMin(calJ.calendar); // the calendar's default booking length, not the slot grid
    if (calJ.calendar?.name) title = calJ.calendar.name;
  }
  /* She may already be on this calendar — the AI books leads here in chat,
     and booking again after the deposit meant two or three confirmations and
     reminders for one session (Alma Tejeda / Mood Studios: Oct 3 + Oct 5 +
     Nov 5, 2026-09-30; 19 more contacts across 13 accounts). Reuse an
     appointment that sits at exactly the time she paid for — that is
     unmistakably this session. The only thing ever moved is the AI's fresh
     hold (below); a confirmed appointment may be a touch-up or an earlier
     paid session. Other recent, unpaid appointments left on the calendar
     get the "onebox-check-appointments" tag (and an Alerts card when they
     will send their own confirmations). */
  // Paid one-box bookings for her, by phone or contact id (two plain
  // filters — a phone like "(505) 870-4376" can't go inside an .or()).
  const [{ tz, appts, ok: lookedUp, error: lookupError }, { data: byPhone }, { data: byContact }] = await Promise.all([
    liveAppointmentsOnCalendar(contactId, calendarId, locationId, tok.token),
    svc.from("onebox_leads").select("ghl_appointment_id").eq("slug", slug).eq("phone", phone),
    svc.from("onebox_leads").select("ghl_appointment_id").eq("slug", slug).eq("ghl_contact_id", contactId),
  ]);
  const mine = [...(byPhone ?? []), ...(byContact ?? [])];
  // A slot with no offset (the reserved-time path) is the studio's wall
  // clock: give it the studio's offset, or — timezone unknown — keep the end
  // on the same wall clock so GHL reads both the same way.
  const offsetLess = !/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(startTime);
  const startIso = offsetLess && tz ? wallToIso(startTime, tz) : startTime;
  const endTime = offsetLess && !tz
    ? new Date(Date.parse(startTime.slice(0, 19) + "Z") + durationMin * 60000).toISOString().slice(0, 19)
    : new Date(Date.parse(startIso) + durationMin * 60000).toISOString();
  const paidIds = new Set((mine as { ghl_appointment_id: string | null }[]).map((r) => r.ghl_appointment_id).filter(Boolean));
  const recent = Date.now() - 30 * 86400_000;
  // Same back-off as the lookup: a 429 or a blip must not leave a paying
  // client on an unconfirmed hold.
  const putAppointment = async (id: string, patch: Record<string, unknown>) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, attempt === 1 ? 400 : 1200));
      const ok = await fetch(`https://services.leadconnectorhq.com/calendars/events/appointments/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { ...H, Version: "2021-04-15" },
        body: JSON.stringify(patch),
      }).then((r) => r.ok).catch(() => false);
      if (ok) return true;
    }
    return false;
  };
  // Includes the AI's unpaid hold ("invalid") — confirming it here is the
  // whole point: it IS the session she just paid for.
  const same = appts.find((a) => Math.abs(a.startMs - Date.parse(startIso)) < 60_000);
  /* A hold the workflow can still confirm: booked in the last few days, not
     paid for, and either still "invalid" or confirmed moments ago — the
     deposit tag often lands (and the workflow flips the hold) a few seconds
     BEFORE this read: Jacqueline / Rachel / Hilda, Oct 20–22. */
  const fresh = Date.now() - AI_HOLD_LIVE_MS;
  const isFreshHold = (a: ContactAppointment) => !paidIds.has(a.id) && (a.addedMs || 0) >= fresh
    && (a.status === AI_HOLD_STATUS
      || (a.status === "confirmed" && (a.updatedMs || 0) >= Date.now() - 15 * 60_000 && (a.updatedMs || 0) - (a.addedMs || 0) > 60_000));
  /* She paid for a different time than the one the AI is holding — she
     picked again on the pay page, or went back to the funnel. The account's
     "Invalid -> Confirm" workflow confirms that hold as soon as the deposit
     lands, so booking a new appointment leaves her with two, at two times.
     With exactly one fresh hold, move THAT appointment to the paid time
     instead. Only fresh holds are ever moved, and two or more can't be told
     apart, so those book as before and get flagged. */
  const holds = same ? [] : appts.filter(isFreshHold);
  let reused: { id: string } | null = null;
  let movedFrom = "";
  let needsReview = false;
  if (same) {
    // Already at the paid time — never book over it, even if confirming fails.
    reused = { id: same.id };
    /* An AI hold is left to the account's "Invalid -> Confirm" workflow,
       which confirms it the moment the deposit tag lands. Any API change
       to an appointment re-fires "Customer Booked Appointment", which turns
       it back into a hold 10 minutes later — and if the tag is already
       there, the confirm workflow fires again: a second "your appointment
       is confirmed" text (all 13 duplicates cancelled by API, 2026-10-25).
       A hold older than the workflow's 3-day wait is ours to confirm. */
    const workflowWillConfirm = same.status === AI_HOLD_STATUS && (same.addedMs || 0) >= Date.now() - 3 * 86400_000;
    if (same.status !== "confirmed" && !workflowWillConfirm
      && !(await putAppointment(same.id, { appointmentStatus: "confirmed" }))) needsReview = true;
  } else if (holds.length === 1) {
    // A refused move falls through to a new booking; the hold is flagged below.
    if (await putAppointment(holds[0].id, { startTime: startIso, endTime, appointmentStatus: "confirmed" })) {
      reused = { id: holds[0].id };
      movedFrom = holds[0].startIso;
    }
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
      .is("ghl_appointment_id", null) // a returning client's earlier paid session stays recorded
      .then(() => {});
    await stampPaid(svc, slug, phone, null);
    // Owner (2026-10-12): any booking glitch must reach the Alerts tab.
    await filePaidNotBookedAlert(svc, { slug, locationId, contactId, name: fullName, slotIso: startIso, error: aj.message ?? `appointment ${ar.status}` }).catch(() => {});
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
  if (movedFrom) console.info("[onebox/book] moved the AI's hold", bookedId, "from", movedFrom, "to", startIso);
  const extras = appts.filter((a) => a.id !== bookedId && !paidIds.has(a.id) && (a.addedMs || 0) >= recent);
  /* Appointments from this chat left at OTHER times that will send their own
     confirmations: fresh holds (the workflow confirms them as the deposit
     lands, or just did) and anything booked confirmed in the last few days. */
  const otherHolds = extras.filter((a) => Math.abs(a.startMs - Date.parse(startIso)) >= 60_000
    && (isFreshHold(a) || ((a.status === "confirmed" || a.status === "new") && (a.addedMs || 0) >= fresh)));
  /* We just POSTed a new appointment: read the calendar again and make
     sure nothing else sits at the same minute (Cheryl Fredieu / Estrella
     Fernandez, The Aesthetic Couture, 2026-10-19: two confirmed
     appointments each, every confirmation and reminder twice). */
  let twins: string[] = [];
  let verifyNote = "";
  if (!reused && bookedId) {
    const after = await liveAppointmentsOnCalendar(contactId, calendarId, locationId, tok.token);
    if (after.ok) {
      // Not listed yet (GHL lag) → compare against the time we just booked.
      const at = after.appts.find((a) => a.id === bookedId)?.startMs ?? Date.parse(startIso);
      twins = after.appts.filter((a) => a.id !== bookedId && Math.abs(a.startMs - at) < 60_000).map((a) => a.id);
    } else {
      verifyNote = `could not re-check the calendar after booking (${after.error ?? "no response"})`;
    }
  }
  if (!lookedUp) console.warn("[onebox/book] appointment lookup failed before booking:", contactId, lookupError);
  if (twins.length || verifyNote || !lookedUp || otherHolds.length || needsReview) {
    const holdsOnly = !twins.length && otherHolds.length > 0;
    await fileDoubleBookingAlert(svc, {
      slug, locationId, contactId, name: fullName, startIso,
      ids: [...(bookedId ? [bookedId] : []), ...twins, ...(holdsOnly ? otherHolds.map((a) => a.id) : [])].sort(),
      otherTimes: holdsOnly ? otherHolds.map((a) => a.startIso) : undefined,
      note: twins.length ? ""
        : holdsOnly ? `The other one was booked in the chat; it sends its own confirmation and reminders (the account's "Appointment Status Invalid -> Confirm" workflow confirms the AI's hold as soon as the deposit lands). Cancel that one.`
        : needsReview && lookedUp && !verifyNote ? `Her appointment at the paid time (${bookedId}) is still unconfirmed — GHL refused the confirm. Open it and set it to Confirmed.`
        : `${verifyNote || `the lookup before booking failed (${lookupError ?? "unknown"})`} — check the contact's calendar by hand.`,
    }).catch(() => {});
    const note = twins.length ? `double booked with ${twins.join(", ")}` : holdsOnly ? `other appointment(s) left at other times: ${otherHolds.map((a) => a.id).join(", ")}` : needsReview && lookedUp && !verifyNote ? `could not confirm ${bookedId}` : (verifyNote || `lookup failed: ${lookupError ?? "unknown"}`);
    // This journey's row only — the note must not overwrite another row's answers.
    if (leadPreRes.data?.id) {
      await svc.from("onebox_leads")
        .update({ answers: { ...((leadPreRes.data.answers as Record<string, unknown> | null) ?? {}), book_note: note } })
        .eq("id", leadPreRes.data.id).then(() => {}, () => {});
    }
  }
  const leftover = needsReview || extras.length > 0 || twins.length > 0;
  if (leftover) console.warn("[onebox/book] other live appointments remain for", contactId, [...extras.map((a) => a.id), ...twins]);
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
    /* Never over a returning client's earlier paid row: its appointment id
       is how every later booking (and the double-booking sweep) knows that
       session was paid for. */
    svc
      .from("onebox_leads")
      .update({ ghl_status: "booked", ghl_contact_id: contactId, ghl_appointment_id: bookedId })
      .eq("slug", slug)
      .eq("phone", phone)
      .or(bookedId ? `ghl_appointment_id.is.null,ghl_appointment_id.eq.${bookedId}` : "ghl_appointment_id.is.null")
      .then(() => stampPaid(svc, slug, phone, bookedId)),
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
        } else {
          // Visible, not silent: the heal cron re-tries leads whose tag never landed.
          await svc.from("onebox_leads")
            .update({ artist_notify_note: `tag failed: HTTP ${tr.status} ${(await tr.text().catch(() => "")).slice(0, 120)}` })
            .eq("slug", slug).eq("phone", phone);
        }
      } catch (e) {
        // best effort — the appointment itself is already booked; the heal cron re-tries the tag
        await svc.from("onebox_leads")
          .update({ artist_notify_note: `tag failed: ${e instanceof Error ? e.message : "error"}`.slice(0, 300) })
          .eq("slug", slug).eq("phone", phone).then(() => {}, () => {});
      }
    })(),
    // Server-side Purchase — this endpoint only runs once the deposit has
    // cleared, so it is the honest signal for optimising on paying clients.
    // B2B books a free call (no purchase); the agency workflow's own
    // appointment-status CAPI covers Meta, same as the original funnel.
    (async () => {
      if (isB2B) return;
      if (!pixelId || !token || !eventId) {
        await recordCapi(svc, {
          slug, eventName: "Purchase", eventId, pixelId, phone, ok: false,
          error: !pixelId ? "no pixel on funnel" : !token ? "no META_CAPI_TOKEN" : "no event id from browser",
        });
        return;
      }
      const amount = parseFloat(String(cfg.deposit ?? "").replace(/[^0-9.]/g, ""));
      const res = await sendCapiEvent({
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
      }).catch(() => ({ ok: false, error: "send threw" }));
      await recordCapi(svc, { slug, eventName: "Purchase", eventId, pixelId, phone, ok: res.ok, error: res.error });
    })(),
  ]);

  return NextResponse.json({ ok: true, appointmentId: aj.id ?? null });
}

/* When the deposit was paid (owner, 10/29/2026: the deposit-ask test must
   tell a lead who paid right on the page from one who paid after texting
   the AI). First payment only — a retry of the same booking keeps it. */
async function stampPaid(svc: ReturnType<typeof createServiceClient>, slug: string, phone: string, bookedId: string | null) {
  await svc
    .from("onebox_leads")
    .update({ paid_at: new Date().toISOString() })
    .eq("slug", slug)
    .eq("phone", phone)
    .is("paid_at", null)
    .or(bookedId ? `ghl_appointment_id.is.null,ghl_appointment_id.eq.${bookedId}` : "ghl_appointment_id.is.null")
    .then(() => {}, () => {});
}
