import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { notifyPaidBookings } from "@/lib/paid-booking-notify";

export const maxDuration = 120;
export const fetchCache = "force-no-store";

// Every 5 min (vercel.json): paid bookings the artist never heard about —
// the AI booked them, not the funnel (owner 11/18/2026). ?dry=1 lists only.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const svc = createServiceClient();
  const result = await notifyPaidBookings(svc, { dryRun: req.nextUrl.searchParams.get("dry") === "1" });
  await svc.from("app_settings").upsert({ key: "artist_notify_status", value: { at: new Date().toISOString(), ...result }, updated_by: "cron artist-notify", updated_at: new Date().toISOString() });
  if (result.errors.length) console.error("[artist-notify]", JSON.stringify(result.errors.slice(0, 10)));
  return NextResponse.json(result);
}
