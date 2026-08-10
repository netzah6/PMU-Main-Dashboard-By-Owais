import { getAppLocationToken } from "@/lib/ghl-app";

// Setter & Closer capacity for the next 7 days, live from GHL.
//
// The embedded CEO page drove this from a proxy that had gone dead. Rebuilding
// it, /calendars/events turned out to be unreachable — the marketplace app is
// not granted calendars/events.readonly, so it answers 401 "token is not
// authorized for this scope" (the same wall the appointment ingest hit, which
// is why that one reads per-contact instead).
//
// /calendars/{id}/free-slots IS readable under calendars.readonly, takes a
// userId, and returns open slots grouped by day — which is exactly what
// capacity means here. So capacity is measured as bookable availability rather
// than by counting existing events.
const AGENCY_LOCATION_ID = "SfpNMJ5YU9lBkxss47lK"; // PMU Bookings On Demand

// Matched by name, not id, so a rebuilt user doesn't silently empty the card.
const PEOPLE = [
  { role: "Setter" as const, match: /jennifer/i },
  { role: "Closer" as const, match: /maria\s+de\s+las/i },
];

export interface DaySlots {
  date: string;
  slots: number;
  /** Local "HH:mm" for every open slot, so the UI can draw a real week grid. */
  times: string[];
}
export interface PersonCapacity {
  role: "Setter" | "Closer";
  name: string;
  calendars: string[];
  days: DaySlots[];
  totalSlots: number;
}
export interface CapacityResult {
  people: PersonCapacity[];
  from: string;
  to: string;
  generatedAt: string;
  error?: string;
}

// Team membership and the user list change rarely but cost ~14 GHL round trips
// to rebuild, which was the whole reason this endpoint took ~12s. Cache the
// slow-moving half; free-slots (the part that actually changes) is always live.
type Roster = { users: Array<Record<string, unknown>>; cals: { id: string; name: string; members: string[] }[] };
let rosterCache: { at: number; data: Roster } | null = null;
const ROSTER_TTL_MS = 30 * 60 * 1000;

const H = (token: string, version = "2021-04-15") => ({
  Authorization: `Bearer ${token}`,
  Version: version,
  Accept: "application/json",
});

export async function getSetterCloserCapacity(days = 7): Promise<CapacityResult> {
  const now = new Date();
  const from = now.toISOString().slice(0, 10);
  const endMs = now.getTime() + days * 86_400_000;
  const to = new Date(endMs).toISOString().slice(0, 10);
  const empty = { people: [], from, to, generatedAt: new Date().toISOString() };

  try {
    const { token, error } = await getAppLocationToken(AGENCY_LOCATION_ID);
    if (!token) return { ...empty, error: error ?? "no GHL token for the agency sub-account" };

    if (rosterCache && Date.now() - rosterCache.at < ROSTER_TTL_MS) {
      return buildFromRoster(rosterCache.data, token, now, endMs, days, from, to);
    }

    const usersRes = await fetch(
      `https://services.leadconnectorhq.com/users/?locationId=${AGENCY_LOCATION_ID}`,
      { headers: H(token, "2021-07-28") }
    );
    if (!usersRes.ok) return { ...empty, error: `users HTTP ${usersRes.status}` };
    const users = (await usersRes.json()).users ?? [];

    const calRes = await fetch(
      `https://services.leadconnectorhq.com/calendars/?locationId=${AGENCY_LOCATION_ID}`,
      { headers: H(token) }
    );
    if (!calRes.ok) return { ...empty, error: `calendars HTTP ${calRes.status}` };
    const calendars = ((await calRes.json()).calendars ?? []).filter(
      (c: { isActive?: boolean }) => c.isActive !== false
    );

    // Team membership only comes back on the single-calendar read.
    const detailed = await Promise.all(
      calendars.map(async (c: { id: string; name?: string }) => {
        try {
          const r = await fetch(`https://services.leadconnectorhq.com/calendars/${c.id}`, { headers: H(token) });
          if (!r.ok) return null;
          const j = await r.json();
          const cal = j.calendar ?? j;
          return {
            id: c.id,
            name: String(cal.name ?? c.name ?? ""),
            members: (cal.teamMembers ?? []).map((t: { userId?: string }) => String(t.userId ?? "")),
          };
        } catch { return null; }
      })
    );
    const cals = detailed.filter(Boolean) as { id: string; name: string; members: string[] }[];
    rosterCache = { at: Date.now(), data: { users, cals } };

    return buildFromRoster({ users, cals }, token, now, endMs, days, from, to);
  } catch (err) {
    return { people: [], from, to, generatedAt: new Date().toISOString(), error: String(err) };
  }
}

// Free-slots only: the part that has to be live. ~7 requests instead of ~21.
async function buildFromRoster(
  roster: Roster, token: string, now: Date, endMs: number,
  days: number, from: string, to: string
): Promise<CapacityResult> {
  try {
    const { users, cals } = roster;
    const people: PersonCapacity[] = [];
    for (const p of PEOPLE) {
      const u = users.find((x: { firstName?: string; lastName?: string }) =>
        p.match.test(`${x.firstName ?? ""} ${x.lastName ?? ""}`.trim())
      );
      if (!u) { people.push({ role: p.role, name: "—", calendars: [], days: [], totalSlots: 0 }); continue; }

      const mine = cals.filter((c) => c.members.includes(String(u.id)));
      const byDay = new Map<string, Set<string>>();

      await Promise.all(
        mine.map(async (c) => {
          try {
            const url = `https://services.leadconnectorhq.com/calendars/${c.id}/free-slots`
              + `?startDate=${now.getTime()}&endDate=${endMs}&userId=${u.id}`;
            const r = await fetch(url, { headers: H(token) });
            if (!r.ok) return;
            const j = (await r.json()) as Record<string, unknown>;
            // Shape is { "YYYY-MM-DD": { slots: [...] }, ... } plus stray keys.
            for (const [date, val] of Object.entries(j)) {
              if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
              const slots = (val as { slots?: unknown[] })?.slots;
              if (!Array.isArray(slots)) continue;
              const set = byDay.get(date) ?? new Set<string>();
              for (const iso of slots) {
                // "2026-08-09T09:15:00-07:00" — keep the calendar's own local
                // time; converting to the viewer's zone would move the slot.
                const m = String(iso).match(/T(\d{2}):(\d{2})/);
                if (m) set.add(`${m[1]}:${m[2]}`);
              }
              byDay.set(date, set);
            }
          } catch { /* one calendar failing shouldn't blank the person */ }
        })
      );

      // Always emit every day in the window, even the empty ones, so the card
      // shows the next 7 days regardless of what is booked.
      const daysOut: DaySlots[] = [];
      for (let i = 0; i < days; i++) {
        const d = new Date(now.getTime() + i * 86_400_000).toISOString().slice(0, 10);
        const times = [...(byDay.get(d) ?? new Set<string>())].sort();
        daysOut.push({ date: d, slots: times.length, times });
      }

      people.push({
        role: p.role,
        name: `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim(),
        calendars: mine.map((c) => c.name),
        days: daysOut,
        totalSlots: daysOut.reduce((s, d) => s + d.slots, 0),
      });
    }

    return { people, from, to, generatedAt: new Date().toISOString() };
  } catch (err) {
    return { people: [], from, to, generatedAt: new Date().toISOString(), error: String(err) };
  }
}
