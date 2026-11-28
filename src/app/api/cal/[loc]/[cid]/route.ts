import { NextResponse } from "next/server";
import { icsFor, loadCalendarEntry } from "@/lib/add-to-calendar";

/* The .ics file behind "Add to Apple Calendar" on /cal/<loc>/<cid> (public,
   no login, read only, 11/28/2026). iPhone Safari opens it straight into
   "Add to Calendar"; Outlook and most Android calendars accept it too. */

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { loc: string; cid: string } }) {
  const e = await loadCalendarEntry(params.loc, params.cid).catch(() => null);
  if (!e) return NextResponse.json({ error: "Appointment not found" }, { status: 404 });
  return new NextResponse(icsFor(e), {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="appointment.ics"',
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}
