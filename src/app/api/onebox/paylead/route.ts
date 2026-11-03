import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getSurveyFieldMap, liveAppointmentsOnCalendar, parseReservedTime, wallToIso } from "@/lib/onebox";
import { getAppLocationToken } from "@/lib/ghl-app";

// Payment-link lookup: the AI's follow-up message sends the lead
//   {{custom_values.cc__deposit_funnel_url}}?t={{contact.id}}
// (/​<slug>/confirm). The engine calls this with the slug + that contact id
// and gets back the lead's identity and reserved slot, so the page can land
// straight on the deposit step with everything filled in. The contact id is
// the bearer credential — GHL ids are long random strings the lead received
// in their own text message; nothing here is served without one.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export async function GET(req: NextRequest) {
  const slug = String(req.nextUrl.searchParams.get("slug") ?? "").trim().toLowerCase();
  const t = String(req.nextUrl.searchParams.get("t") ?? "").trim();
  if (!slug || !/^[A-Za-z0-9]{8,40}$/.test(t)) {
    return NextResponse.json({ ok: false }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const svc = createServiceClient();
  const [{ data: client }, { data: lead }, { data: paidRows }] = await Promise.all([
    svc.from("onebox_clients").select("location_id, config").eq("slug", slug).maybeSingle(),
    svc.from("onebox_leads")
      .select("full_name, phone, answers, slot_iso, ghl_status")
      .eq("slug", slug).eq("ghl_contact_id", t)
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
    // Appointments the one-box already booked for her after a deposit —
    // never offered again as the one to pay for.
    svc.from("onebox_leads").select("ghl_appointment_id")
      .eq("slug", slug).eq("ghl_contact_id", t).not("ghl_appointment_id", "is", null),
  ]);
  if (!client) {
    return NextResponse.json({ ok: false }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  /* One GHL read serves two needs: the reserved time the AI may have
     agreed in chat, and — for leads who never came through the one-box
     (everyone from before the client's traffic moved, plus anyone the AI
     is texting who arrived on the old GHL page) — the identity itself.
     Without this the confirm link only worked for one-box leads and
     everyone else got the plain funnel (Christina Edison / Archery,
     2026-09-20). The contact endpoint is location-scoped, so an id from
     another account simply 404s. */
  let ghl: { name: string; phone: string; email: string; reserved: string } | null = null;
  // Her booked appointment on the funnel's calendar, if the AI (or the
  // team) already made one — the time she actually agreed to in chat.
  let booked = "";
  let tz = "";
  const paidIds = new Set(((paidRows ?? []) as { ghl_appointment_id: string | null }[]).map((r) => String(r.ghl_appointment_id)));
  try {
    const tok = await getAppLocationToken(client.location_id as string);
    if (tok.token) {
      const calendarId = String((client.config as Record<string, string> | null)?.calendarId ?? "");
      const [fieldMap, r, appts] = await Promise.all([
        getSurveyFieldMap(client.location_id as string, tok.token),
        fetch(`https://services.leadconnectorhq.com/contacts/${t}`, {
          headers: { Authorization: `Bearer ${tok.token}`, Version: "2021-07-28", Accept: "application/json" },
        }),
        calendarId
          ? liveAppointmentsOnCalendar(t, calendarId, client.location_id as string, tok.token)
          : Promise.resolve({ tz: "", appts: [] }),
      ]);
      /* Only a recent booking (the chat that sent this link), never one a
         deposit already paid for — an older appointment is more likely a
         touch-up or an unrelated visit than the time she's paying for. */
      tz = appts.tz;
      const recent = Date.now() - 21 * 86400_000;
      booked = appts.appts.find((a) => !paidIds.has(a.id) && (a.addedMs || 0) >= recent)?.startIso ?? "";
      if (r.ok) {
        const j = (await r.json()) as { contact?: { firstName?: string; lastName?: string; name?: string; phone?: string; email?: string; locationId?: string; customFields?: { id?: string; value?: unknown }[] } };
        const c = j.contact;
        if (c && (!c.locationId || c.locationId === client.location_id)) {
          const f = fieldMap.reserved_time ? (c.customFields ?? []).find((x) => x.id === fieldMap.reserved_time) : undefined;
          ghl = {
            name: String(c.name || [c.firstName, c.lastName].filter(Boolean).join(" ") || "").trim(),
            phone: String(c.phone ?? ""), email: String(c.email ?? ""),
            reserved: f?.value ? parseReservedTime(String(f.value)) : "",
          };
        }
      }
    }
  } catch { /* fall through: one-box record or 404 */ }
  if (!lead && !ghl) {
    return NextResponse.json({ ok: false }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  /* Which time the page offers, most-recent intent first: an appointment
     already on her calendar (booked in chat), then the reserved-time field,
     then the slot she picked in the funnel — and that last one only while
     it's still ahead. The funnel pick used to win outright, so a lead who
     agreed Nov 5 with the AI was shown (and booked into) her old Oct 3 pick
     on top of the AI's appointment (Alma Tejeda, 2026-09-30). */
  const ahead = (iso: string) => (iso && Date.parse(iso) > Date.now() ? iso : "");
  const funnelPick = String(lead?.slot_iso ?? "");
  // The reserved-time field is the studio's wall clock; judge it in her tz.
  const reserved = ghl?.reserved ? (tz ? ahead(wallToIso(ghl.reserved, tz)) : ghl.reserved) : "";
  const slotIso = booked || reserved || ahead(funnelPick);
  const email = String((lead?.answers as { email?: string } | null)?.email ?? "") || ghl?.email || "";
  return NextResponse.json(
    { ok: true, name: String(lead?.full_name ?? "") || ghl?.name || "", phone: String(lead?.phone ?? "") || ghl?.phone || "", email, slotIso },
    { headers: { "Cache-Control": "no-store" } }
  );
}
