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
// guesses arrive in SHEET-ROW order. Returns one timestamp per entry.
export function resolveDates(guesses: (DateGuess | null)[]): number[] {
  const out: number[] = new Array(guesses.length).fill(NaN);
  // forward pass: prev = last value we settled on, next = nearest date ahead
  // that can only be read one way (an ambiguous row is never used as an anchor).
  let prev = NaN;
  for (let i = 0; i < guesses.length; i++) {
    const g = guesses[i];
    if (!g) continue;
    if (!g.ambiguous) { out[i] = g.mmdd; prev = g.mmdd; continue; }
    let next = NaN;
    for (let j = i + 1; j < guesses.length; j++) {
      const n = guesses[j];
      if (n && !n.ambiguous) { next = n.mmdd; break; }
    }
    const fits = (t: number) =>
      (isNaN(prev) || t >= prev) && (isNaN(next) || t <= next);
    // MM/DD is the sheet's dominant format, so it wins ties and dead ends.
    out[i] = fits(g.mmdd) ? g.mmdd : fits(g.ddmm) ? g.ddmm : g.mmdd;
    prev = out[i];
  }
  return out;
}
export const dateLabel = (ms: number): string =>
  isNaN(ms) ? "—" : new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
export const dateShort = (ms: number): string =>
  isNaN(ms) ? "—" : new Date(ms).toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "2-digit" });
