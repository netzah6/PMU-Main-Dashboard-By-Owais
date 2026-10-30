import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { scanBlastReplies } from "@/lib/blast-replies";

export const maxDuration = 300;

// Every 30 min: who replied to a text blast, and was it positive.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await scanBlastReplies(createServiceClient()));
}
