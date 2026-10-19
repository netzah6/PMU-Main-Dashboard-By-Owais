import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/ppa";
import { getReplyAccount } from "@/lib/ghl-conversations";
import { DEFAULT_SIZE, MAX_SIZE, sequenceSummary, startBatch } from "@/lib/winback-sequence";

export const maxDuration = 300;

// "▶ Start next batch" (admin only). { dryRun: true } previews who would be
// texted and who was skipped (current clients, no phone, DND, in touch
// lately) and writes nothing; { dryRun: false, sheetRows } stamps the batch
// on exactly the people the preview showed and tags them — the day-0 text
// then goes out from the winback-send cron within 15 minutes.
export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const acct = await getReplyAccount();
  if (!acct) return NextResponse.json({ error: "PMU Bookings On Demand token not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { size?: number; dryRun?: boolean; sheetRows?: unknown };
  const size = Math.min(MAX_SIZE, Math.max(1, Math.floor(Number(body.size) || DEFAULT_SIZE)));
  // Anything but an explicit false is a preview — the safe default.
  const dryRun = body.dryRun !== false;
  // The rows the owner confirmed in the preview (a real run never re-picks on its own).
  const sheetRows = Array.isArray(body.sheetRows) ? body.sheetRows.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, MAX_SIZE) : undefined;
  if (!dryRun && !sheetRows?.length) return NextResponse.json({ error: "Preview the batch first — a real start needs the rows you confirmed" }, { status: 400 });
  try {
    return NextResponse.json(await startBatch(acct, { size, dryRun, sheetRows }));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

// Where the sequence stands: people per step, stopped reasons, next due.
export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });
  try {
    return NextResponse.json(await sequenceSummary(createServiceClient()));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
