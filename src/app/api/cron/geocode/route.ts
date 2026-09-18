import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { geocodeMissing } from "@/lib/geocode";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Daily: geocode any Clients Master address the Map tab can't place yet
// (new clients, changed addresses). ≤40 per run at Nominatim's 1 req/s.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await geocodeMissing(createServiceClient(), 40);
  return NextResponse.json({ timestamp: new Date().toISOString(), result });
}
