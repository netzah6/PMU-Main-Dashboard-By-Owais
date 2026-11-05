import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/lib/ppa";
import { getReplyAccount } from "@/lib/ghl-conversations";
import { runFollowup } from "@/lib/winback-followup";

export const maxDuration = 300;

// "💬 Follow up" (admin only): people who answered the win-back texts but did
// not come back. { dryRun: true } previews who gets which text (price shared →
// the $60 hold; not shared → limited spots + call link) and sends nothing;
// { dryRun: false, sheetRows, until } texts exactly the people the owner
// ticked, each re-checked right before her text goes out.
export async function POST(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (auth.role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });
  const acct = await getReplyAccount();
  if (!acct) return NextResponse.json({ error: "PMU Bookings On Demand token not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { dryRun?: boolean; until?: string; sheetRows?: unknown };
  // Anything but an explicit false is a preview — the safe default.
  const dryRun = body.dryRun !== false;
  const sheetRows = Array.isArray(body.sheetRows) ? body.sheetRows.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 100) : undefined;
  if (!dryRun && !sheetRows?.length) return NextResponse.json({ error: "Preview first — a real send needs the people you ticked" }, { status: 400 });
  try {
    return NextResponse.json(await runFollowup(acct, { dryRun, until: body.until, sheetRows }));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
