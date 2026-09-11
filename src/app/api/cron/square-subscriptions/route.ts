import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { squareConfigured } from "@/lib/square";
import { refreshSquareSnapshot } from "@/lib/square-snapshot";

export const maxDuration = 300;

// Keeps the Square subscriptions snapshot warm so the tab always opens
// instantly. Cron secret, or an admin.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronOk = !!process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`;
  if (!cronOk) {
    const auth = await getAuth();
    if (!auth || auth.role !== "admin") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!squareConfigured()) return NextResponse.json({ skipped: "Square not configured" });
  const snap = await refreshSquareSnapshot(createServiceClient());
  const counts = (snap.payload.counts as { total?: number } | undefined) ?? {};
  return NextResponse.json({ fetchedAt: snap.fetchedAt, durationMs: snap.durationMs, total: counts.total ?? null, error: snap.error });
}
