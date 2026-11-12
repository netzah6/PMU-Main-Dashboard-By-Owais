import { NextRequest, NextResponse } from "next/server";
import { bookingSlots, changeBooking, type BookingChange } from "@/lib/client-app-bookings";

/* Client app · Bookings: the free times for moving one appointment (GET) and
   the move / cancel itself (POST). All the checks live in client-app-bookings. */
export const dynamic = "force-dynamic";
export const maxDuration = 60; // a quiet cancel waits a few seconds before it tidies up the workflow

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const r = await bookingSlots(q.get("token") ?? "", q.get("id") ?? "");
  return r.ok ? NextResponse.json({ days: r.days, now: r.now }) : NextResponse.json({ error: r.error }, { status: r.status });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as ({ token?: string; id?: string } & BookingChange) | null;
  if (!body) return NextResponse.json({ error: "Not available" }, { status: 400 });
  const r = await changeBooking(String(body.token ?? ""), String(body.id ?? ""), body);
  return r.ok ? NextResponse.json({ ok: true, settled: r.settled }) : NextResponse.json({ error: r.error }, { status: r.status });
}
