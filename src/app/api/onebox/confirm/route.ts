import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAppLocationToken } from "@/lib/ghl-app";

// Never serve cached fetches: appointment state must be live.
export const fetchCache = "force-no-store";

// Confirms the appointment once the deposit is paid. /book creates it as
// "new" (which still holds the slot), and the funnel calls this from the
// checkout's success event — so a lead who never pays never shows up as a
// confirmed booking on the client's calendar.
export async function POST(req: NextRequest) {
  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }

  const slug = String(body.slug ?? "").slice(0, 100);
  const appointmentId = String(body.appointmentId ?? "").slice(0, 100);
  const phone = String(body.phone ?? "").trim().slice(0, 40);
  if (!slug || !appointmentId) {
    return NextResponse.json({ ok: false, error: "missing fields" }, { status: 400 });
  }

  const svc = createServiceClient();
  const { data: client } = await svc
    .from("onebox_clients")
    .select("location_id, status, config")
    .eq("slug", slug)
    .single();
  if (!client || client.status === "draft") {
    return NextResponse.json({ ok: false, error: "unknown funnel" }, { status: 404 });
  }
  const locationId = client.location_id as string;
  const calendarId = (client.config as Record<string, string>)?.calendarId ?? "";

  const tok = await getAppLocationToken(locationId);
  if (!tok.token) return NextResponse.json({ ok: false, error: "no token" }, { status: 502 });
  const H = {
    Authorization: `Bearer ${tok.token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    Version: "2021-04-15",
  };

  // Only ever touch an appointment that belongs to this funnel's calendar.
  const url = `https://services.leadconnectorhq.com/calendars/events/appointments/${encodeURIComponent(appointmentId)}`;
  const check = await fetch(url, { headers: H });
  if (!check.ok) {
    return NextResponse.json({ ok: false, error: "appointment not found" }, { status: 404 });
  }
  // The single-appointment GET answers with { appointment }, the list
  // endpoints with { event } — accept either so the check really runs.
  type Appt = { calendarId?: string; locationId?: string };
  const cj = (await check.json()) as { appointment?: Appt; event?: Appt };
  const ev = cj.appointment ?? cj.event;
  if (!ev || (ev.locationId && ev.locationId !== locationId) || (ev.calendarId && calendarId && ev.calendarId !== calendarId)) {
    return NextResponse.json({ ok: false, error: "not this funnel's appointment" }, { status: 403 });
  }

  const r = await fetch(url, {
    method: "PUT",
    headers: H,
    body: JSON.stringify({ appointmentStatus: "confirmed" }),
  });
  if (!r.ok) {
    console.error("[onebox/confirm] failed:", r.status, (await r.text()).slice(0, 300));
    return NextResponse.json({ ok: false, error: `confirm ${r.status}` }, { status: 502 });
  }

  if (phone) {
    await svc
      .from("onebox_leads")
      .update({ ghl_status: "paid" })
      .eq("slug", slug)
      .eq("phone", phone)
      .then(() => {});
  }
  return NextResponse.json({ ok: true });
}
