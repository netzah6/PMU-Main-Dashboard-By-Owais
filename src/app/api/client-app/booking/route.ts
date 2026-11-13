import { NextRequest, NextResponse } from "next/server";
import { bookForLead, bookOptions, bookingSlots, changeBooking, type BookingChange } from "@/lib/client-app-bookings";

/* Client app · Bookings: the free times for moving one appointment (GET) and
   the move / cancel itself (POST). All the checks live in client-app-bookings. */
export const dynamic = "force-dynamic";
export const maxDuration = 60; // a quiet cancel waits a few seconds before it tidies up the workflow

/* A crash must still answer with words the screen can show. On a test build
   the reason is included, to find it fast; never on the live app. */
const crash = (e: unknown) => NextResponse.json({
  error: "Something went wrong. Please try again.",
  ...(process.env.VERCEL_ENV !== "production" ? { detail: e instanceof Error ? `${e.message} | ${(e.stack ?? "").split("\n").slice(1, 4).join(" | ")}` : String(e) } : {}),
}, { status: 500 });

export async function GET(req: NextRequest) {
  try { return await get(req); } catch (e) { console.error("[client-app/booking GET]", e); return crash(e); }
}
async function get(req: NextRequest) {
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
  try { return await post(req); } catch (e) { console.error("[client-app/booking POST]", e); return crash(e); }
}
async function post(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as ({ token?: string; id?: string; contact?: string; calendar?: string; start?: unknown } & (BookingChange | { action: "book" })) | null;
  if (!body) return NextResponse.json({ error: "Not available" }, { status: 400 });
  if (body.action === "book") {
    const b = await bookForLead(String(body.token ?? ""), String(body.contact ?? ""), String(body.calendar ?? ""), body.start);
    return b.ok ? NextResponse.json({ ok: true, when: b.when, confirmed: b.confirmed }) : NextResponse.json({ error: b.error }, { status: b.status });
  }
  const r = await changeBooking(String(body.token ?? ""), String(body.id ?? ""), body);
  return r.ok ? NextResponse.json({ ok: true, settled: r.settled }) : NextResponse.json({ error: r.error }, { status: r.status });
}
