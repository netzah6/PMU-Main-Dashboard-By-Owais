// ── report-date disambiguation ───────────────────────────────────────────────
// When both parts of "a/b/YYYY" are <= 12 the string alone cannot say which is
// the month: "11/3/2026" is Nov 3 under MM/DD and Mar 11 under DD/MM. Reading
// it the wrong way throws a client's timeline out of order — Successbrows had a
// March report land after September, which is what the client reported.
// 914 of ~2,200 tracking rows are ambiguous like this.
//
// The sheet is append-ordered per client, so the row order is an INDEPENDENT
// witness to the sequence (verified: of 973 consecutive pairs of unambiguous
// dates, 955 agree with row order). So: resolve each ambiguous date to the
// reading that keeps the client's reports moving forward, anchored on the
// dates that can only be read one way.
export interface DateGuess { mmdd: number; ddmm: number; ambiguous: boolean }
export function dateGuess(s: string): DateGuess | null {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) {
    const dt = new Date(s.trim());
    if (isNaN(dt.getTime())) return null;
    return { mmdd: dt.getTime(), ddmm: dt.getTime(), ambiguous: false };
  }
  const a = +m[1], b = +m[2], y = +m[3];
  const at = (mo: number, d: number) => new Date(y, mo - 1, d).getTime();
  if (a > 12) { const t = at(b, a); return { mmdd: t, ddmm: t, ambiguous: false }; }
  if (b > 12) { const t = at(a, b); return { mmdd: t, ddmm: t, ambiguous: false }; }
  return { mmdd: at(a, b), ddmm: at(b, a), ambiguous: true };
}
// ── fleet-wide resolution ────────────────────────────────────────────────────
// The tracking sheet is a BATCH sheet: the team files one row per client on a
// shared reporting day, so "12/8/2025" is 50 rows across 49 different clients
// and every one of them means the SAME calendar day.
//
// Resolving per client (the first version of this) therefore split a single
// reporting day in two -- 12/8/2025 came out as Aug 12 on one client's tab and
// Dec 8 on another's, because each client was judged only against its own
// neighbours and some clients have no later anchor to judge against. 17 date
// strings covering 470 rows landed on two different dates that way.
//
// So resolve each STRING once, using every client that uses it as evidence,
// then apply that one answer everywhere. Each occurrence votes only when it
// discriminates -- when one reading fits its client's anchors and the other
// does not. Measured over the live table this is near-unanimous and never
// contested: of 43 ambiguous strings, 21 vote DD/MM, 6 vote MM/DD, 16 have no
// evidence either way, and ZERO have votes on both sides.
//   "12/8/2025"  -> 50 votes DD/MM,  0 MM/DD  -> Aug 12 2025
//   "11/3/2026"  -> 32 votes DD/MM,  0 MM/DD  -> Mar 11 2026
//   "8/4/2026"   ->  0 votes DD/MM, 47 MM/DD  -> Aug 4 2026

/**
 * Build one reading per distinct date string, from every client at once.
 *
 * @param perClient each client's raw date strings in SHEET-ROW order. Row order
 *   is the evidence: the sheet is appended per client, so a client's reports run
 *   forward, and the dates that can only be read one way anchor the rest.
 * @returns raw string -> timestamp (NaN when unparseable).
 */
export function buildDateIndex(perClient: string[][]): Map<string, number> {
  const mmddVotes = new Map<string, number>();
  const ddmmVotes = new Map<string, number>();
  const guessOf = new Map<string, DateGuess>();

  for (const raws of perClient) {
    const gs = raws.map(dateGuess);
    for (let i = 0; i < gs.length; i++) {
      const g = gs[i];
      if (!g) continue;
      guessOf.set(raws[i], g);
      if (!g.ambiguous) continue;

      // Nearest unambiguous date behind and ahead of this row, for THIS client.
      // Ambiguous rows are never anchors -- only facts anchor.
      let prev = NaN, next = NaN;
      for (let j = i - 1; j >= 0; j--) { const n = gs[j]; if (n && !n.ambiguous) { prev = n.mmdd; break; } }
      for (let j = i + 1; j < gs.length; j++) { const n = gs[j]; if (n && !n.ambiguous) { next = n.mmdd; break; } }
      const fits = (t: number) => (isNaN(prev) || t >= prev) && (isNaN(next) || t <= next);
      const m = fits(g.mmdd), d = fits(g.ddmm);
      // Only a discriminating occurrence votes. "Both fit" says nothing.
      if (m && !d) mmddVotes.set(raws[i], (mmddVotes.get(raws[i]) ?? 0) + 1);
      else if (d && !m) ddmmVotes.set(raws[i], (ddmmVotes.get(raws[i]) ?? 0) + 1);
    }
  }

  const index = new Map<string, number>();
  for (const [raw, g] of guessOf) {
    if (!g.ambiguous) { index.set(raw, g.mmdd); continue; }
    const d = ddmmVotes.get(raw) ?? 0, m = mmddVotes.get(raw) ?? 0;
    // MM/DD is the sheet's nominal format, so it takes ties and no-evidence.
    index.set(raw, d > m ? g.ddmm : g.mmdd);
  }
  // Same string, same answer, for every client. That is the whole point.
  return index;
}

export const dateLabel = (ms: number): string =>
  isNaN(ms) ? "—" : new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
export const dateShort = (ms: number): string =>
  isNaN(ms) ? "—" : new Date(ms).toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "2-digit" });

/**
 * Read a date string the way the Reports tab has decided to read it.
 *
 * The index is built from the Date column, but "Last Strategy?" holds the same
 * kind of string. Looking it up here keeps one literal from rendering two ways
 * a few pixels apart; a string the index has never seen falls back to the
 * caller's parser. Deliberately a LOOKUP, not a vote -- strategy-call dates do
 * not run in sheet order, so letting them vote would corrupt the evidence.
 */
export function msFromIndex(index: Map<string, number>, raw: string): number {
  const hit = index.get(raw.trim());
  return hit === undefined ? NaN : hit;
}
