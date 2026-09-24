// Parse DD/MM/YYYY, MM/DD/YYYY, or ISO dates into a timestamp for range filtering.
export function parseMs(s: string): number {
  const str = s.trim();
  if (!str) return NaN;
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const a = +m[1], b = +m[2], y = +m[3];
    let day: number, mon: number;
    if (a > 12) { day = a; mon = b; }
    else if (b > 12) { mon = a; day = b; }
    else { day = a; mon = b; }
    const dt = new Date(y, mon - 1, day);
    return isNaN(dt.getTime()) ? NaN : dt.getTime();
  }
  const dt = new Date(str);
  return isNaN(dt.getTime()) ? NaN : dt.getTime();
}

// ── booking de-duplication ───────────────────────────────────────────────────
// The bookings sheet repeats the same appointment: 1,383 of 3,750 dated rows
// (37%) are the same person on the same day, and more are the same person one
// day later — a reschedule written as a second row rather than an edit. Both
// read as "double bookings" in this list (owner, 2026-09-23).
//
// Collapsed here, NOT filtered away: the kept row carries how many raw rows it
// stands for, so the count on screen still traces back to the sheet.
//
// Same day or next day ONLY (owner, 2026-09-24): "if they are a few days apart
// separate them as few different bookings but if it's the same or next day merge
// them as 1". A next-day row is the same appointment moved; two days out is
// already a different appointment and keeps its own row.
export const DUP_WINDOW_DAYS = 1;

/** phone (digits) > email > name — the first one this row actually has. */
export function personKey(r: Record<string, unknown>): string {
  const phone = String(r.phone ?? "").replace(/\D/g, "");
  if (phone.length >= 7) return "p:" + phone;
  const email = String(r.email ?? "").trim().toLowerCase();
  if (email) return "e:" + email;
  return "n:" + String(r.name ?? "").trim().toLowerCase();
}

export type Deduped = Record<string, unknown> & { _dupes?: number };

/** Collapse same-person bookings within DUP_WINDOW_DAYS; keep the latest. */
export function dedupeBookings(rows: Record<string, unknown>[]): Deduped[] {
  const byPerson = new Map<string, Record<string, unknown>[]>();
  const undated: Deduped[] = [];
  for (const r of rows) {
    const key = personKey(r);
    // No person and no date to group on — never merge, or unrelated blanks
    // would collapse into one another.
    if (key === "n:" || isNaN(parseMs(String(r.date ?? "")))) { undated.push(r); continue; }
    byPerson.set(key, [...(byPerson.get(key) ?? []), r]);
  }

  const kept: Deduped[] = [];
  for (const group of byPerson.values()) {
    const sorted = [...group].sort((a, b) => parseMs(String(a.date ?? "")) - parseMs(String(b.date ?? "")));
    let run: Record<string, unknown>[] = [];
    const flush = () => {
      if (!run.length) return;
      // Keep the LAST row of the run: for a reschedule that is the date the
      // appointment actually moved to.
      kept.push({ ...run[run.length - 1], _dupes: run.length });
      run = [];
    };
    for (const r of sorted) {
      if (!run.length) { run = [r]; continue; }
      const gap = (parseMs(String(r.date ?? "")) - parseMs(String(run[run.length - 1].date ?? ""))) / 86400000;
      // Compare against the PREVIOUS row, not the run's first, so a genuine
      // weekly series does not chain into one row.
      if (gap <= DUP_WINDOW_DAYS) run.push(r); else { flush(); run = [r]; }
    }
    flush();
  }
  return [...kept, ...undated];
}

