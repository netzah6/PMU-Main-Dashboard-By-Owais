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
    // Thu/Fri/Sat get their own numbers — fleet-wide, appointments land
    // overwhelmingly on those days, so their availability is what matters.
    const primeByDow: Record<number, { slots: number; minutes: number }> = {
      4: { slots: 0, minutes: 0 }, 5: { slots: 0, minutes: 0 }, 6: { slots: 0, minutes: 0 },
    };

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
            const [y, mo, d] = k.split("-").map(Number);
            const dow = new Date(y, mo - 1, d).getDay();
            if (primeByDow[dow]) { primeByDow[dow].slots += n; primeByDow[dow].minutes += n * slotDur; }
          }
        }
      }
    }

    // Demand side: Thu-Sat appointments booked in the last 30 days. Coverage =
    // weekly open prime slots / weekly booked prime appts. Fleet analysis
    // (2026-08-28): top earners sit at 1.5-2x; below 1.5x prime days sell out
    // and leads who only want Thu-Sat see nothing; above ~2x extra hours add no
    // deposits. shortHours = hours to ask the client to add to reach 1.5x.
    let primeBooked30 = 0;
    for (const cal of cals) {
      const er = await fetch(`${BASE}/calendars/events?locationId=${acct.locationId}&calendarId=${cal.id}&startTime=${start - 30 * 86400000}&endTime=${start}`, { headers: H });
      if (!er.ok) continue;
      const evs = (((await er.json()).events ?? []) as Array<Record<string, unknown>>)
        .filter((e) => !/cancel|no.?show|invalid/i.test(String(e.appointmentStatus ?? "")));
      for (const e of evs) {
        const dw = new Date(String(e.startTime)).getDay();
        if (dw >= 4 && dw <= 6) primeBooked30++;
      }
    }

    openSlots = Math.round(openSlots);
    const hrs = (m: number) => Math.round((m / 60) * 10) / 10;
    const day = (d: number) => ({ slots: Math.round(primeByDow[d].slots), hours: hrs(primeByDow[d].minutes) });
    const prime = { thu: day(4), fri: day(5), sat: day(6) };
    const primeSlotsTotal = prime.thu.slots + prime.fri.slots + prime.sat.slots;
    const primeMinutesTotal = primeByDow[4].minutes + primeByDow[5].minutes + primeByDow[6].minutes;
    const weeklyBooked = Math.round((primeBooked30 / 30) * 7 * 10) / 10;
    const weeklyOpen = Math.round((primeSlotsTotal / DAYS) * 7 * 10) / 10;
    const coverage = weeklyBooked > 0 ? Math.round((weeklyOpen / weeklyBooked) * 100) / 100 : null;
    const avgSlotMin = primeSlotsTotal > 0 ? primeMinutesTotal / primeSlotsTotal : 30;
    const shortSlots = weeklyBooked > 0 ? Math.max(0, weeklyBooked * 1.5 - weeklyOpen) : 0;
    const shortHours = Math.round(((shortSlots * avgSlotMin) / 60) * 10) / 10;
    return NextResponse.json({
      available: true,
      openSlots,
      openHours: hrs(openMinutes),
      pctFree: capacitySlots > 0 ? Math.round((openSlots / capacitySlots) * 100) : null,
      prime: {
        ...prime,
        slots: primeSlotsTotal,
        hours: Math.round((prime.thu.hours + prime.fri.hours + prime.sat.hours) * 10) / 10,
        weeklyBooked,
        weeklyOpen,
        coverage,
        shortHours,
      },
      lookBusy: { on: lookBusyOn, percentage: lookBusyPct },
    });
  } catch (e) {
    return NextResponse.json({ available: false, reason: String(e) });
  }
}
