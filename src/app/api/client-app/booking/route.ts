import { NextRequest, NextResponse } from "next/server";
import { bookForLead, bookOptions, bookingSlots, changeBooking, type BookingChange } from "@/lib/client-app-bookings";

/* Client app · Bookings: the free times for moving one appointment (GET) and
   the move / cancel itself (POST). All the checks live in client-app-bookings. */
export const dynamic = "force-dynamic";
export const maxDuration = 60; // a quiet cancel waits a few seconds before it tidies up the workflow

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  // ?contact= : the free times for a NEW appointment with this lead (from her chat).
  if (q.get("contact")) {
    const b = await bookOptions(q.get("token") ?? "", q.get("contact") ?? "", q.get("calendar") ?? undefined);
    return b.ok ? NextResponse.json({ calendars: b.calendars, calendarId: b.calendarId, days: b.days, already: b.already }) : NextResponse.json({ error: b.error }, { status: b.status });
  }
  const r = await bookingSlots(q.get("token") ?? "", q.get("id") ?? "");
  return r.ok ? NextResponse.json({ days: r.days, now: r.now }) : NextResponse.json({ error: r.error }, { status: r.status });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as ({ token?: string; id?: string; contact?: string; calendar?: string; start?: unknown } & (BookingChange | { action: "book" })) | null;
  if (!body) return NextResponse.json({ error: "Not available" }, { status: 400 });
  if (body.action === "book") {
    const b = await bookForLead(String(body.token ?? ""), String(body.contact ?? ""), String(body.calendar ?? ""), body.start);
    return b.ok ? NextResponse.json({ ok: true, when: b.when }) : NextResponse.json({ error: b.error }, { status: b.status });
  }
  const r = await changeBooking(String(body.token ?? ""), String(body.id ?? ""), body);
  return r.ok ? NextResponse.json({ ok: true, settled: r.settled }) : NextResponse.json({ error: r.error }, { status: r.status });
}
