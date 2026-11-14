import { NextRequest, NextResponse } from "next/server";
import { buildDialerData, enrollInWorkflow } from "@/lib/power-dialer";
import { dialerSeat } from "@/lib/power-dialer-seat";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// "Start dialer": put the ticked contacts into the caller's GHL Power Dialer
// workflow (Manual Action → Call). The caller then works them one at a time
// in GHL → Conversations → Manual Actions.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { contactIds?: string[]; userId?: string };
  const ids = [...new Set((body.contactIds ?? []).filter((x) => typeof x === "string" && /^[A-Za-z0-9]{10,40}$/.test(x)))];
  if (!ids.length) return NextResponse.json({ error: "Pick at least one lead" }, { status: 400 });
  if (ids.length > 300) return NextResponse.json({ error: "Max 300 leads at a time" }, { status: 400 });
  const data = await buildDialerData();
  const seat = await dialerSeat(data.users);
  if (!seat) return NextResponse.json({ error: "Admins and sales seats only" }, { status: 403 });
  // Sales seats always dial as themselves; admins may send to anyone set up.
  const userId = seat.isAdmin ? (body.userId || seat.ghlUser?.id) : seat.ghlUser?.id;
  const wf = userId ? seat.workflows[userId] : undefined;
  if (!userId || !wf) return NextResponse.json({ error: "No Power Dialer workflow is set up for this person yet" }, { status: 400 });
  // Only leads that are on a list this seat can see.
  const allowed = new Set(Object.values(data.lists).flat().map((r) => r.contactId));
  const use = ids.filter((id) => allowed.has(id));
  const res = await enrollInWorkflow(wf, use);
  return NextResponse.json({ sent: res.ok.length, failed: res.failed, skipped: ids.length - use.length });
}
