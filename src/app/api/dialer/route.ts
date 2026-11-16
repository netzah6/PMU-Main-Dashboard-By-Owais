import { NextRequest, NextResponse } from "next/server";
import { buildDialerData, CALL_WINDOWS, DIALER_LISTS, LOCAL_OK_FROM, LOCAL_OK_TO, type DialerListKey } from "@/lib/power-dialer";
import { dialerSeat } from "@/lib/power-dialer-seat";
import { autopilotKey } from "@/lib/power-dialer-autopilot";

export const maxDuration = 90;
export const dynamic = "force-dynamic";

// Power dialer lists (Sales tab → Dialer). Setter seats get the setter lists,
// closer seats the closer lists, "sales" + admins both.
export async function GET(req: NextRequest) {
  try {
    const data = await buildDialerData(req.nextUrl.searchParams.get("fresh") === "1");
    const seat = await dialerSeat(data.users);
    if (!seat) return NextResponse.json({ error: "Admins and sales seats only" }, { status: 403 });
    const keys = (Object.keys(DIALER_LISTS) as DialerListKey[]).filter((k) =>
      DIALER_LISTS[k].side === "setter" ? seat.seesSetter : seat.seesCloser);
    return NextResponse.json({
      builtAt: data.builtAt,
      lists: keys.map((k) => ({ key: k, label: DIALER_LISTS[k].label, side: DIALER_LISTS[k].side, rows: data.lists[k] })),
      windows: CALL_WINDOWS,
      localOk: [LOCAL_OK_FROM, LOCAL_OK_TO],
      me: seat.ghlUser,
      isAdmin: seat.isAdmin,
      // Key for the Autopilot bookmark (only when this person has a dialer set up).
      // Admins only until the owner has tried it on a real call (11/16/2026).
      autopilotKey: seat.isAdmin && seat.ghlUser && seat.workflows[seat.ghlUser.id] ? autopilotKey(seat.ghlUser.id) : null,
      // Who a list can be sent to: anyone with a Power Dialer workflow set up.
      dialers: data.users.filter((u) => seat.workflows[u.id]).map((u) => ({ id: u.id, name: u.name })),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
