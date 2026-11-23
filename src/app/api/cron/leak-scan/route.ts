import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { leakScanSample, leakScanTick } from "@/lib/leak-scan";

export const maxDuration = 300;

// Nightly leak check (owner, 11/23/2026): every 5 minutes from 00:00 to
// 04:55 PT it reads the next batch of V3 chats; the last tick writes the
// summary and any new leaks to the 🩹 Leaks tab. Read-only everywhere else.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    // ?sample=N: label N chats and save nothing (testing).
    const sample = Number(req.nextUrl.searchParams.get("sample") ?? 0);
    const convs = (req.nextUrl.searchParams.get("conv") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    if (sample > 0 || convs.length) return NextResponse.json({ sample: await leakScanSample(createServiceClient(), Math.min(sample, 40), convs) });
    return NextResponse.json(await leakScanTick(createServiceClient(), { budgetMs: 240_000 }));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
