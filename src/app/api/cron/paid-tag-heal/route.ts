import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { healPaidTags } from "@/lib/paid-tag-heal";

export const maxDuration = 120;

// Every 10 min: paid deposits whose GHL contact never got the paid tag.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await healPaidTags(createServiceClient());
  return NextResponse.json({ timestamp: new Date().toISOString(), ...result });
}
