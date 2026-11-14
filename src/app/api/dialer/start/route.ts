import { NextRequest, NextResponse } from "next/server";
import { buildDialerData, startDialer, type DialerListKey } from "@/lib/power-dialer";
import { dialerSeat } from "@/lib/power-dialer-seat";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// "Start dialer": put the ticked contacts into the caller's GHL Power Dialer
// workflow (Manual Action → Call). The caller then works them one at a time
// in GHL → Conversations → Manual Actions.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { contactIds?: string[]; userId?: string; list?: string };
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
  // Each lead goes in with the list it is on (decides which text it gets).
  const listOf = new Map<string, DialerListKey>();
  for (const [k, rows] of Object.entries(data.lists) as Array<[DialerListKey, typeof data.lists[DialerListKey]]>) for (const r of rows) if (!listOf.has(r.contactId)) listOf.set(r.contactId, k);
  if (body.list && body.list in data.lists) for (const id of ids) if (data.lists[body.list as DialerListKey].some((r) => r.contactId === id)) listOf.set(id, body.list as DialerListKey);
  const use = ids.filter((id) => listOf.has(id));
  const caller = data.users.find((u) => u.id === userId)?.name ?? "";
  const res = await startDialer(wf, caller, use.map((id) => ({ id, list: listOf.get(id)! })));
  return NextResponse.json({ sent: res.ok.length, failed: res.failed, skipped: ids.length - use.length });
}
