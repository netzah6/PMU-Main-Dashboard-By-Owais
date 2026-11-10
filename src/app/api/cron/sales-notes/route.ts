import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { sweepPending } from "@/lib/contact-notes";

export const maxDuration = 300;

// Every 10 min: organize the sales notes of any stored call that was not
// processed yet (AI error, crash, contact busy). See lib/contact-notes.
export async function GET(req: NextRequest) {
  if (process.env.CRON_SECRET && req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const results = await sweepPending(createServiceClient());
  return NextResponse.json({ timestamp: new Date().toISOString(), results });
}
