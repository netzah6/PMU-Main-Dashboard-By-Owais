import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getV3Accounts } from "@/lib/ghl-ingest";

export const maxDuration = 60;

const BASE = "https://services.leadconnectorhq.com";
const VER = "2021-04-15";
const DAYS = 14;

// Calendar availability for the next 2 weeks: open appointment slots, the hours
// they represent, and % of the calendar's capacity that's still open.
export async function GET(
  _req: NextRequest,
  { params }: { params: { ownerKey: string } }
) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const ownerKey = decodeURIComponent(params.ownerKey).toLowerCase().trim();

  try {
    const acct = (await getV3Accounts()).find((a) => a.ownerKey === ownerKey);
    if (!acct) return NextResponse.json({ available: false, reason: "no_account" });

    const H = { Authorization: `Bearer ${acct.token}`, Version: VER, Accept: "application/json" };
    const start = Date.now();
    const end = start + DAYS * 86400000;

    const calRes = await fetch(`${BASE}/calendars/?locationId=${acct.locationId}`, { headers: H });
    if (!calRes.ok) return NextResponse.json({ available: false, reason: "cal_list_failed" });
    const cals = (((await calRes.json()).calendars ?? []) as Array<Record<string, unknown>>)
      .filter((c) => c.isActive !== false);
    if (!cals.length) return NextResponse.json({ available: false, reason: "no_calendar" });

    let openSlots = 0;
    let openMinutes = 0;
    let capacitySlots = 0;
    let lookBusyOn = false;
    let lookBusyPct = 0;

    for (const cal of cals) {
      const cfg = (((await (await fetch(`${BASE}/calendars/${cal.id}`, { headers: H })).json()).calendar) ?? {}) as Record<string, unknown>;
      const slotDur = Number(cfg.slotDuration) || 30;
      // "Look Busy" hides a % of real openings from the free-slots API — scale back up.
      const lb = (cfg.lookBusyConfig ?? {}) as { enabled?: boolean; lookBusyPercentage?: number };
      const lbPct = Math.min(99, Math.max(0, Number(lb.lookBusyPercentage) || 0));
      const lbOn = !!lb.enabled && lbPct > 0;
      if (lbOn) { lookBusyOn = true; lookBusyPct = Math.max(lookBusyPct, lbPct); }
      const factor = lbOn ? 1 / (1 - lbPct / 100) : 1;
      const slotInterval = Number(cfg.slotInterval) || 1;
      const slotIntervalMin = String(cfg.slotIntervalUnit ?? "").startsWith("hour") ? slotInterval * 60 : slotInterval;

      // Capacity = open minutes per weekday / slot interval, summed over the window.
      const perDow: Record<number, number> = {};
      ((cfg.openHours ?? []) as Array<Record<string, unknown>>).forEach((o) => {
        const mins = ((o.hours ?? []) as Array<Record<string, number>>).reduce(
          (s, h) => s + ((h.closeHour * 60 + h.closeMinute) - (h.openHour * 60 + h.openMinute)),
          0
        );
        ((o.daysOfTheWeek ?? []) as number[]).forEach((d) => { perDow[d] = (perDow[d] ?? 0) + mins; });
      });
      for (let i = 0; i < DAYS; i++) {
        const dow = new Date(start + i * 86400000).getDay();
        const openMin = perDow[dow] ?? 0;
        if (slotIntervalMin > 0) capacitySlots += Math.floor(openMin / slotIntervalMin);
      }

      const fr = await fetch(`${BASE}/calendars/${cal.id}/free-slots?startDate=${start}&endDate=${end}`, { headers: H });
      if (fr.ok) {
        const fj = (await fr.json()) as Record<string, { slots?: string[] }>;
        for (const k of Object.keys(fj)) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(k)) {
            const n = (fj[k].slots ?? []).length * factor;
            openSlots += n;
            openMinutes += n * slotDur;
          }
        }
      }
    }

    openSlots = Math.round(openSlots);
    return NextResponse.json({
      available: true,
      openSlots,
      openHours: Math.round((openMinutes / 60) * 10) / 10,
      pctFree: capacitySlots > 0 ? Math.round((openSlots / capacitySlots) * 100) : null,
      lookBusy: { on: lookBusyOn, percentage: lookBusyPct },
    });
  } catch (e) {
    return NextResponse.json({ available: false, reason: String(e) });
  }
}
