import { NextRequest, NextResponse } from "next/server";
import { dialerUsers } from "@/lib/power-dialer";
import { dialerSeat } from "@/lib/power-dialer-seat";
import { buildDialerActivity, type DialerRange } from "@/lib/dialer-activity";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

// Sales → Dialer → Activity (owner 11/15/2026): what the chosen caller did —
// her calls per day (time, outcome, inside the call windows or not) and each
// lead sent to her dialer: call 1, call 2, the text. Admins pick the person;
// a sales seat only sees its own.
//   GET ?user=<GHL user id>&range=today|yesterday|7d[&fresh=1]
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const users = await dialerUsers();
    const seat = await dialerSeat(users);
    if (!seat) return NextResponse.json({ error: "Admins and sales seats only" }, { status: 403 });
    // Who can be picked: everyone with a Power Dialer workflow (admins only).
    const people = users.filter((u) => seat.workflows[u.id]).map((u) => ({ id: u.id, name: u.name }));
    // An admin who names nobody sees the setter first (the owner's ask).
    const fallback = people.find((p) => /^jennifer/i.test(p.name))?.id ?? seat.ghlUser?.id ?? people[0]?.id;
    const want = seat.isAdmin ? (sp.get("user") || fallback) : seat.ghlUser?.id;
    const caller = users.find((u) => u.id === want);
    if (!caller) return NextResponse.json({ error: "No GHL user found for you yet" }, { status: 400 });
    const r = sp.get("range");
    const range: DialerRange = r === "yesterday" || r === "7d" ? r : "today";
    const act = await buildDialerActivity(caller, range, users, sp.get("fresh") === "1");
    return NextResponse.json({ ...act, people: seat.isAdmin ? people : [], isAdmin: seat.isAdmin }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
