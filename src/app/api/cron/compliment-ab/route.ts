import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { checkCompliments } from "@/lib/compliment-ab";

export const fetchCache = "force-no-store";
export const maxDuration = 300;

// Hourly: which side of the photo-compliment test each slay lead got, how she
// replied, and whether she booked / paid (the Funnels-tab "Photo compliment
// (AI)" card). See src/lib/compliment-ab.ts. A run that hits the time budget
// keeps its cursor and picks up the rest next hour.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const svc = createServiceClient();
  const result = await checkCompliments(svc);
  return NextResponse.json({ timestamp: new Date().toISOString(), ...result });
}
