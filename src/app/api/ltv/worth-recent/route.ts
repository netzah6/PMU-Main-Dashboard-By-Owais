import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { getRecentFees } from "@/lib/worth-recent";

export const fetchCache = "force-no-store";
// A month that was never matched is built once (Square + sheet), then cached.
export const maxDuration = 300;

/* Performance tab (admin): service fees per client for the last 6 full
   months, from Payment Check. See src/lib/worth-recent.ts. */
export async function GET(req: NextRequest) {
  const cron = !!process.env.CRON_SECRET && req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  if (!cron) {
    const auth = await getAuth();
    if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (auth.role !== "admin") return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }
  try {
    return NextResponse.json(await getRecentFees());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
