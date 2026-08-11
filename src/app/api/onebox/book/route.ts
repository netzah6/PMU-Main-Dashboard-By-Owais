import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken } from "@/lib/ghl-app";

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
    .select("slug, location_id, status, config")
    .eq("slug", slug)
    .single();
  const calendarId = (client?.config as Record<string, string>)?.calendarId;
  if (!client || client.status === "draft" || !calendarId) {
    return NextResponse.json({ ok: false, error: "unknown funnel" }, { status: 404 });
  }
  const locationId = client.location_id as string;

  const tok = await getAppLocationToken(locationId);
  if (!tok.token) return NextResponse.json({ ok: false, error: "no token" }, { status: 502 });
  const H = {
    Authorization: `Bearer ${tok.token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // Contact (idempotent with the survey submit's upsert).
  const [firstName, ...rest] = fullName.split(/\s+/);
  const cr = await fetch("https://services.leadconnectorhq.com/contacts/upsert", {
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
      tags: ["onebox-survey"],
    }),
  });
  const cj = (await cr.json()) as { contact?: { id?: string } };
  const contactId = cj.contact?.id;
  if (!cr.ok || !contactId) {
    return NextResponse.json({ ok: false, error: "contact upsert failed" }, { status: 502 });
  }

  // Calendar meta for duration + title.
  let durationMin = 30;
  let title = "Appointment";
  const calR = await fetch(
    `https://services.leadconnectorhq.com/calendars/${encodeURIComponent(calendarId)}`,
    { headers: { ...H, Version: "2021-04-15" } }
  );
  if (calR.ok) {
    const calJ = (await calR.json()) as { calendar?: { slotDuration?: number; name?: string } };
    if (calJ.calendar?.slotDuration) durationMin = calJ.calendar.slotDuration;
    if (calJ.calendar?.name) title = calJ.calendar.name;
  }
  const endTime = new Date(new Date(startTime).getTime() + durationMin * 60000).toISOString();

  const ar = await fetch("https://services.leadconnectorhq.com/calendars/events/appointments", {
    method: "POST",
    headers: { ...H, Version: "2021-04-15" },
    body: JSON.stringify({
      calendarId,
      locationId,
      contactId,
      startTime,
      endTime,
      title,
      appointmentStatus: "confirmed",
    }),
  });
  const aj = (await ar.json()) as { id?: string; message?: string };
  if (!ar.ok) {
    console.error("[onebox/book] appointment failed:", ar.status, aj);
    return NextResponse.json(
      { ok: false, error: aj.message ?? `appointment ${ar.status}` },
      { status: 502 }
    );
  }

  // Reflect the booking on the stored lead row (best effort).
  await svc
    .from("onebox_leads")
    .update({ ghl_status: "booked", ghl_contact_id: contactId })
    .eq("slug", slug)
    .eq("phone", phone)
    .then(() => {});

  return NextResponse.json({ ok: true, appointmentId: aj.id ?? null });
}
